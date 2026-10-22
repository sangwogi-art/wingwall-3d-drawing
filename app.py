import os
import tempfile
from flask import Flask, request, jsonify, send_file, Response
from flask_cors import CORS

import cad_parser
import model_3d
import exporters

app = Flask(__name__, static_folder='static', static_url_path='/static')
CORS(app, resources={r"/*": {"origins": "*"}})

# In-memory active session state (starts empty until user imports drawings in Step 1)
current_drawings_list = []
current_drawing_data = None
current_model_data = None


def _resolve_classification(drawing_name, manual_type=None):
    """도면명 기반 분류 및 사용자 수동 오버라이드 객체 생성 헬퍼"""
    res = cad_parser.classify_drawing_by_name(drawing_name)
    selected_type = manual_type if manual_type in ('GENERAL', 'REBAR') else res['auto_type']
    label_map = {
        'GENERAL': '일반도',
        'REBAR': '배근도/구조도',
        'UNCLASSIFIED': '미분류 (수동 선택 필요)'
    }
    return {
        'autoType': res['auto_type'],
        'autoLabel': res['auto_label'],
        'matchedKeyword': res['matched_keyword'],
        'reason': res['reason'],
        'needsManualSelection': res['needs_manual_selection'],
        'selectedType': selected_type,
        'selectedLabel': label_map.get(selected_type, res['auto_label']),
        'isManualOverride': bool(manual_type and manual_type != res['auto_type'])
    }


@app.route('/')
def index():
    return send_file('index.html')


@app.route('/api/reset', methods=['POST'])
def api_reset():
    global current_drawings_list, current_drawing_data, current_model_data
    current_drawings_list = []
    current_drawing_data = None
    current_model_data = None
    return jsonify({'status': 'success'})


@app.route('/api/default-drawing', methods=['GET'])
def api_default_drawing():
    return jsonify({
        'status': 'success',
        'drawing': current_drawing_data,
        'drawings': current_drawings_list,
        'model': current_model_data
    })


@app.route('/api/project-drawings', methods=['GET'])
def api_project_drawings():
    return jsonify({
        'status': 'success',
        'drawings': current_drawings_list,
        'drawing': current_drawing_data,
        'model': current_model_data
    })


@app.route('/api/classify', methods=['POST'])
def api_classify():
    """
    1.2 도면 종류 판별 API:
    도면명 키워드 자동 판별 결과 반환 및 수동 선택 업데이트 지원
    """
    global current_drawings_list, current_model_data
    body = request.get_json() or {}
    drawing_name = body.get('drawingName', '')
    manual_type = body.get('manualType')  # Optional: 'GENERAL' or 'REBAR'

    classification_obj = _resolve_classification(drawing_name, manual_type)

    # Update active drawing classification in memory and regenerate 3D model
    for d in current_drawings_list:
        if d.get('fileName') == drawing_name or d.get('id') == drawing_name:
            d['classification'] = classification_obj

    if current_drawings_list:
        current_model_data = model_3d.generate_full_model(drawings_list=current_drawings_list)

    return jsonify({
        'status': 'success',
        'classification': classification_obj,
        'model': current_model_data
    })


@app.route('/api/generate-3d', methods=['POST'])
def api_generate_3d():
    global current_model_data, current_drawings_list
    params = request.get_json() or {}
    model_res = model_3d.generate_full_model(params=params, drawings_list=current_drawings_list)
    current_model_data = model_res
    return jsonify({
        'status': 'success',
        'model': model_res
    })


@app.route('/api/upload', methods=['POST'])
def api_upload():
    files = request.files.getlist('files')
    if not files and 'file' in request.files:
        files = [request.files['file']]

    if not files or all(f.filename == '' for f in files):
        return jsonify({'status': 'error', 'message': '업로드된 도면 파일이 없습니다.'}), 400

    reset_flag = request.form.get('reset', 'false').lower() == 'true'

    temp_dir = tempfile.gettempdir()
    saved_files = []

    # 1. Save all uploaded files first so companion sheets ((01)<->(02), (03)<->(04)) can cross-reference each other
    for file in files:
        filename = os.path.basename(file.filename)
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ('.dwg', '.dxf'):
            return jsonify({'status': 'error', 'message': f'지원하지 않는 파일 형식입니다 ({filename}). .dwg, .dxf만 지원합니다.'}), 400

        temp_path = os.path.join(temp_dir, filename)
        file.save(temp_path)
        saved_files.append((filename, temp_path))

    # 2. Parse each uploaded DWG file
    parsed_drawings = []
    try:
        for filename, temp_path in saved_files:
            drawing_data = cad_parser.parse_dwg(temp_path, custom_filename=filename)
            parsed_drawings.append(drawing_data)
    except Exception as e:
        return jsonify({'status': 'error', 'message': f'도면 분석 중 오류 발생: {str(e)}'}), 500
    finally:
        for _, temp_path in saved_files:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except OSError:
                pass

    global current_drawing_data, current_model_data, current_drawings_list
    if reset_flag or current_drawings_list is None:
        current_drawings_list = []

    # If the user uploads a drawing from a DIFFERENT station (e.g. switching from STA.13+611.21 to STA.0+000.00),
    # automatically replace drawings from old stations so old sample drawings don't pollute the new model.
    new_stations = set()
    for pd in parsed_drawings:
        st = (pd.get('structuralParams') or {}).get('station') or (pd.get('rebarSpecs') or {}).get('station')
        if st:
            new_stations.add(st)

    if new_stations and current_drawings_list:
        filtered_existing = []
        for ed in current_drawings_list:
            ed_st = (ed.get('structuralParams') or {}).get('station') or (ed.get('rebarSpecs') or {}).get('station')
            if not ed_st or ed_st in new_stations:
                filtered_existing.append(ed)
        current_drawings_list = filtered_existing

    existing_by_name = {d['fileName']: i for i, d in enumerate(current_drawings_list)}
    for pd in parsed_drawings:
        if pd['fileName'] in existing_by_name:
            current_drawings_list[existing_by_name[pd['fileName']]] = pd
        else:
            current_drawings_list.append(pd)

    current_drawing_data = parsed_drawings[0]
    current_model_data = model_3d.generate_full_model(drawings_list=current_drawings_list)

    return jsonify({
        'status': 'success',
        'drawing': current_drawing_data,
        'uploadedDrawings': parsed_drawings,
        'drawings': current_drawings_list,
        'model': current_model_data
    })


@app.route('/api/export/<fmt>', methods=['GET', 'POST'])
def api_export(fmt):
    global current_model_data, current_drawings_list
    model = current_model_data
    if request.is_json:
        custom_params = request.get_json()
        model = model_3d.generate_full_model(params=custom_params, drawings_list=current_drawings_list)
    elif model is None:
        model = model_3d.generate_full_model(drawings_list=current_drawings_list)

    fmt = fmt.lower()
    if fmt == 'obj':
        content = exporters.export_obj(model, include_rebars=True)
        return Response(content, mimetype='text/plain', headers={'Content-Disposition': 'attachment; filename=wingwall_model.obj'})
    elif fmt == 'stl':
        content = exporters.export_stl(model)
        return Response(content, mimetype='application/sla', headers={'Content-Disposition': 'attachment; filename=wingwall_model.stl'})
    elif fmt == 'dxf':
        content = exporters.export_dxf_3d(model, include_rebars=True)
        return Response(content, mimetype='application/dxf', headers={'Content-Disposition': 'attachment; filename=wingwall_model_3d.dxf'})
    elif fmt == 'csv':
        content = exporters.export_rebar_bom_csv(model)
        return Response(content, mimetype='text/csv; charset=utf-8', headers={'Content-Disposition': 'attachment; filename=wingwall_rebar_bom.csv'})
    elif fmt == 'json':
        return jsonify(model)
    else:
        return jsonify({'status': 'error', 'message': 'Unsupported format'}), 400


if __name__ == '__main__':
    print("Starting Wingwall 3D & Rebar Modeler Server at http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=False)
