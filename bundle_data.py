import json
import os
import cad_parser
import model_3d
import exporters

os.makedirs('static/data', exist_ok=True)

# 1. Parse all DWG drawings in current workspace and sibling project folders
known_drawings_map = {}
workspace_drawings = cad_parser.parse_all_project_drawings('.')
for d in workspace_drawings:
    known_drawings_map[d['fileName']] = d

parent_dir = '..'
sibling_sets = {'STA.13+611.21': workspace_drawings}
if os.path.exists(parent_dir):
    for sub in sorted(os.listdir(parent_dir)):
        sub_path = os.path.join(parent_dir, sub)
        if os.path.isdir(sub_path) and os.path.abspath(sub_path) != os.path.abspath('.'):
            sub_dwgs = cad_parser.parse_all_project_drawings(sub_path)
            if sub_dwgs:
                for d in sub_dwgs:
                    known_drawings_map[d['fileName']] = d
                st = (sub_dwgs[0].get('structuralParams') or {}).get('station') or (sub_dwgs[0].get('rebarSpecs') or {}).get('station') or sub
                sibling_sets[st] = sub_dwgs

with open('all_drawings_data.json', 'w', encoding='utf-8') as f:
    json.dump(list(known_drawings_map.values()), f, ensure_ascii=False, indent=2)

# 2. Generate 3D exterior + rebar models for each drawing set
known_models_map = {}
for st_key, dwg_list in sibling_sets.items():
    known_models_map[st_key] = model_3d.generate_full_model(drawings_list=dwg_list)

default_model = known_models_map.get('STA.13+611.21') or next(iter(known_models_map.values()))
with open('model_3d.json', 'w', encoding='utf-8') as f:
    json.dump(default_model, f, ensure_ascii=False, indent=2)

# 3. Bundle JS datasets for offline standalone lookup by uploaded filename
with open('static/data/drawing_data.js', 'w', encoding='utf-8') as f:
    f.write('window.KNOWN_DRAWINGS_MAP = ' + json.dumps(known_drawings_map, ensure_ascii=False) + ';\n')
    f.write('window.DEFAULT_DRAWING_DATA = null;\n')
    f.write('window.DEFAULT_DRAWINGS_LIST = [];\n')

with open('static/data/model_3d.js', 'w', encoding='utf-8') as f:
    f.write('window.KNOWN_MODELS_MAP = ' + json.dumps(known_models_map, ensure_ascii=False) + ';\n')
    f.write('window.DEFAULT_MODEL_3D = ' + json.dumps(default_model, ensure_ascii=False) + ';\n')

with open('wingwall_model.obj', 'w', encoding='utf-8') as f:
    f.write(exporters.export_obj(default_model))
with open('wingwall_model.stl', 'w', encoding='utf-8') as f:
    f.write(exporters.export_stl(default_model))
with open('wingwall_model.dxf', 'w', encoding='utf-8') as f:
    f.write(exporters.export_dxf_3d(default_model))

print(f"Bundled {len(known_drawings_map)} DWG drawings and {len(known_models_map)} 3D models into static/data/.")
