#!/usr/bin/env python3
"""
Comprehensive End-to-End Pipeline Verification Test
Verifies 2D drawing classification, DWG parsing, 3D solid & rebar modeling,
mesh watertightness, exporter functionality, and Flask API endpoints.
"""
import os
import sys
import json
import unittest

import cad_parser
import model_3d
import rebar_model
import exporters
import app


class Test3DDrawingPipeline(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        current_dir = os.path.dirname(os.path.abspath(__file__))
        cls.project_root = os.path.abspath(os.path.join(current_dir, '..', '..'))
        cls.rag_dir = os.path.join(cls.project_root, 'RAG')
        cls.general_dwg = os.path.join(cls.rag_dir, '13. 수로암거 일반도(STA.13+611.21)(02).dwg')
        app.app.testing = True
        cls.flask_app = app.app.test_client()

    def test_01_drawing_classification(self):
        """1.2 도면 종류 키워드 기반 자동 판별 검증"""
        # 일반도 판별
        res_gen = cad_parser.classify_drawing_by_name('13. 수로암거 일반도(STA.13+611.21)(02).dwg')
        self.assertEqual(res_gen['auto_type'], 'GENERAL')
        self.assertEqual(res_gen['matched_keyword'], '일반')
        self.assertFalse(res_gen['needs_manual_selection'])

        # 배근도/구조도 판별
        res_rebar1 = cad_parser.classify_drawing_by_name('14. 수로암거 구조도(STA.13+611.21, 종점 우)(01).dwg')
        self.assertEqual(res_rebar1['auto_type'], 'REBAR')
        self.assertIn('구조', res_rebar1['matched_keyword'])
        self.assertFalse(res_rebar1['needs_manual_selection'])

        res_rebar2 = cad_parser.classify_drawing_by_name('날개벽 배근도(종점 좌).dwg')
        self.assertEqual(res_rebar2['auto_type'], 'REBAR')
        self.assertIn('배근', res_rebar2['matched_keyword'])

        # 미분류 도면
        res_unclass = cad_parser.classify_drawing_by_name('기타 도면#01.dwg')
        self.assertEqual(res_unclass['auto_type'], 'UNCLASSIFIED')
        self.assertTrue(res_unclass['needs_manual_selection'])

    def test_02_dwg_parsing(self):
        """1.1 DWG 도면 파싱 및 파라미터 추출 검증"""
        if not os.path.exists(self.general_dwg):
            self.skipTest(f"DWG file not found at {self.general_dwg}")

        drawing_data = cad_parser.parse_dwg(self.general_dwg)
        self.assertIsNotNone(drawing_data)
        self.assertIn('entities', drawing_data)
        self.assertIn('structuralParams', drawing_data)
        self.assertGreater(len(drawing_data['entities']), 100)

        # 수로암거 제원 확인
        sp = drawing_data['structuralParams']
        self.assertEqual(sp.get('station'), 'STA.13+611.21')
        self.assertAlmostEqual(sp.get('culvert_span', 2.0), 2.0, delta=0.1)

    def test_03_3d_solid_modeling_and_watertightness(self):
        """2단계 일반도 기반 3D 외형 모델링 및 수밀성(Watertight) 검증"""
        model_res = model_3d.generate_full_model()
        self.assertIsNotNone(model_res)
        self.assertIn('objects', model_res)

        objects = model_res['objects']
        self.assertIn('culvert', objects)
        self.assertIn('ww_end_left', objects)
        self.assertIn('ww_end_right', objects)

        # 도면에 없는 시점부 날개벽 임의 생성 차단 확인
        self.assertNotIn('ww_start_left', objects)
        self.assertNotIn('ww_start_right', objects)

        # 수밀성 (Watertight 2-Manifold Mesh) 검증
        for part_key in ['culvert', 'ww_end_left', 'ww_end_right']:
            part_data = objects[part_key]
            vertices = part_data['vertices']
            faces = part_data['faces']
            self.assertGreater(len(vertices), 0, f"{part_key} has no vertices")
            self.assertGreater(len(faces), 0, f"{part_key} has no faces")

            # Edge manifold check: Every edge in a watertight 2-manifold closed surface is shared by exactly 2 faces
            edge_count = {}
            for f in faces:
                for i in range(3):
                    v1, v2 = f[i], f[(i + 1) % 3]
                    edge = tuple(sorted([v1, v2]))
                    edge_count[edge] = edge_count.get(edge, 0) + 1

            non_manifold = [e for e, count in edge_count.items() if count != 2]
            self.assertEqual(len(non_manifold), 0,
                             f"{part_key} mesh is not watertight! Non-manifold edges: {len(non_manifold)}")

    def test_04_3d_rebar_modeling(self):
        """3단계 구조도/배근도 기반 날개벽 내부 3D 철근 배근(508본) 검증"""
        rebar_data = rebar_model.generate_full_rebar_model()
        self.assertIsNotNone(rebar_data)
        self.assertIn('wingwalls', rebar_data)
        self.assertIn('summary', rebar_data)

        summary = rebar_data['summary']
        total_bars = summary.get('total_bars', 0)
        self.assertEqual(total_bars, 508, f"Expected 508 total rebars, got {total_bars}")

        # 좌측(231본) 및 우측(277본) 검증
        left_bars = summary.get('left_bars', 0)
        right_bars = summary.get('right_bars', 0)
        self.assertEqual(left_bars, 231)
        self.assertEqual(right_bars, 277)

        # W1 철근 3D 형상 검증: 벽체-저판 접합부에서 꺾이지 않고 저판 하면에서 1회만 꺾이는 ㄱ자 형상(3개 정점) 확인
        for ww_key in ['WW_END_LEFT', 'WW_END_RIGHT']:
            ww_groups = rebar_data['wingwalls'][ww_key]['groups']
            w1_group = next((g for g in ww_groups if g['mark'] == 'W1'), None)
            self.assertIsNotNone(w1_group)
            for poly in w1_group['polylines']:
                self.assertEqual(len(poly), 3, f"{ww_key} W1 bar must have 3 points (1 bend at footing bottom)")
                # 저판 하면 구간(poly[0] -> poly[1]) 동일 Z 표고 유지
                self.assertAlmostEqual(poly[0][2], poly[1][2], places=4)
                # 벽체 긴 구간(poly[1] -> poly[2]) 접합부 꺾임 없이 일직선 연장 확인
                self.assertAlmostEqual(poly[1][0], poly[2][0], places=4)
                self.assertAlmostEqual(poly[1][1], poly[2][1], places=4)

    def test_05_exporters(self):
        """3D 모델 OBJ, STL, DXF 내보내기 검증"""
        model_res = model_3d.generate_full_model()

        obj_str = exporters.export_obj(model_res)
        self.assertIn('v ', obj_str)
        self.assertIn('f ', obj_str)

        stl_str = exporters.export_stl(model_res)
        self.assertIn('solid ', stl_str)
        self.assertIn('facet normal', stl_str)

        dxf_str = exporters.export_dxf_3d(model_res)
        self.assertIn('SECTION', dxf_str)
        self.assertIn('ENTITIES', dxf_str)

        csv_str = exporters.export_rebar_bom_csv(model_res)
        self.assertIn('구분(날개벽)', csv_str)
        self.assertIn('기호(Mark)', csv_str)

    def test_06_flask_web_endpoints(self):
        """Flask API 및 웹 엔드포인트 응답 검증"""
        # 1. 메인 웹페이지
        r_index = self.flask_app.get('/')
        self.assertEqual(r_index.status_code, 200)

        # 2. 기본 도면 데이터 조회 API
        r_def = self.flask_app.get('/api/default-drawing')
        self.assertEqual(r_def.status_code, 200)
        data_def = json.loads(r_def.data)
        self.assertEqual(data_def.get('status'), 'success')

        # 3. 도면 분류 API
        r_cls = self.flask_app.post('/api/classify',
                                    data=json.dumps({'drawingName': '13. 수로암거 일반도.dwg'}),
                                    content_type='application/json')
        self.assertEqual(r_cls.status_code, 200)
        data_cls = json.loads(r_cls.data)
        self.assertEqual(data_cls['classification']['selectedType'], 'GENERAL')


if __name__ == '__main__':
    unittest.main()
