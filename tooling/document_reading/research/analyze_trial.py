"""Offline measurements from retained synthetic observations, not model judging."""
import json
from pathlib import Path


def analyze(job):
    job = Path(job)
    receipt = json.loads((job/'receipt.json').read_text())
    observations = {name: json.loads((job/(name+'.result.json')).read_text()) for name in
                    ['text.pdf', 'table.pdf', 'columns.pdf', 'image.pdf', 'blank.pdf',
                     'synthetic.docx', 'synthetic.pptx', 'synthetic.xlsx']}
    rows = receipt['office_fixtures']['expected_cells']
    expected = {(r, c): text for r, row in enumerate(rows) for c, text in enumerate(row)}
    comparisons = {}
    for name in ['text', 'table', 'columns', 'image', 'blank']:
        observation = observations[name+'.pdf']
        text = '\n'.join(item['text'] for item in observation['texts'])
        baseline = '\n'.join(p['text'] for p in receipt['baseline_extractions'][name]['pages'])
        comparisons[name+'.pdf'] = {'status': observation['status'],
            'matches_pdfkit_token_sequence': text.split() == baseline.split(),
            'text_empty': not text.strip(), 'native_table_count': len(observation['tables']),
            'text_item_count': len(observation['texts']),
            'all_text_items_have_page_box': (all(item['provenance'] and all(
                p['page_no'] == 1 and 'bbox' in p for p in item['provenance']) for item in observation['texts']) if observation['texts'] else None)}
    column_tokens = ' '.join(t['text'] for t in observations['columns.pdf']['texts']).split()
    comparisons['columns.pdf']['column_major_order'] = column_tokens == 'LEFT FIRST LEFT SECOND RIGHT FIRST RIGHT SECOND'.split()
    for name in ['synthetic.docx', 'synthetic.pptx', 'synthetic.xlsx']:
        observation = observations[name]
        tables = observation['tables']
        cells = {(c['start_row_offset_idx'], c['start_col_offset_idx']): c['text']
                 for c in tables[0]['table_cells']} if len(tables) == 1 else {}
        comparisons[name] = {'status': observation['status'], 'table_count': len(tables),
            'exact_expected_cell_texts_and_coordinates': cells == expected and len(tables[0]['table_cells']) == 9,
            'page_count_as_reported_not_invented': observation['page_count']}
    return {'scope': 'eight authored fixtures; no OCR/models/app integration',
            'comparisons': comparisons, 'observations': observations}


if __name__ == '__main__':
    import sys
    print(json.dumps(analyze(sys.argv[1]), indent=2))
