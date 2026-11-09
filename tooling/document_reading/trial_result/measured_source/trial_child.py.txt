"""Synthetic-only trial commands; invoke inside the network-denied job sandbox."""
import errno
import hashlib
import json
from pathlib import Path
import socket
import sys


def network_probe():
    results = {}
    for name, action in [('bind', lambda s: s.bind(('127.0.0.1', 0))),
                         ('connect', lambda s: s.connect(('192.0.2.1', 9)))]:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(.2)
                action(sock)
            results[name] = {'denied': False, 'reason': 'operation succeeded'}
        except OSError as error:
            results[name] = {'denied': error.errno in (errno.EPERM, errno.EACCES), 'errno': error.errno}
    print(json.dumps({'network_probe': results}))
    if not all(result['denied'] for result in results.values()):
        raise SystemExit(2)


def import_probe():
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.pipeline.native_pdf_pipeline import NativePdfPipeline
    from docling.datamodel.pipeline_options import NativePdfPipelineOptions
    from docling.datamodel.base_models import InputFormat
    print(json.dumps({'imports': 'passed', 'converter': DocumentConverter.__name__,
                      'native_pipeline': NativePdfPipeline.__name__}))


def generate_office():
    from docx import Document
    from openpyxl import Workbook
    from pptx import Presentation
    from pptx.util import Inches
    directory = Path.cwd() / 'fixtures'
    rows = [['Item', 'Quantity', 'Cost'], ['Pencils', '12', '24'], ['Folders', '3', '18']]
    doc = Document()
    doc.add_heading('Synthetic Cedar Office Memo', level=1)
    doc.add_paragraph('Project Cedar ships on 14 November 2026. Owner: Ada Example.')
    table = doc.add_table(rows=3, cols=3)
    for r, values in enumerate(rows):
        for c, value in enumerate(values):
            table.cell(r, c).text = value
    doc.save(directory / 'synthetic.docx')
    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[5])
    slide.shapes.title.text = 'Synthetic Cedar Slide'
    table = slide.shapes.add_table(3, 3, Inches(1), Inches(2), Inches(7), Inches(2)).table
    for r, values in enumerate(rows):
        for c, value in enumerate(values):
            table.cell(r, c).text = value
    deck.save(directory / 'synthetic.pptx')
    book = Workbook()
    sheet = book.active
    sheet.title = 'Cedar Inventory'
    for row in rows:
        sheet.append(row)
    book.save(directory / 'synthetic.xlsx')
    fixtures = {}
    for name in ['synthetic.docx', 'synthetic.pptx', 'synthetic.xlsx']:
        data = (directory/name).read_bytes()
        if len(data) > 1024*1024:
            raise ValueError('Generated fixture too large')
        fixtures[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    result = {'authored': True, 'expected_cells': rows, 'fixtures': fixtures}
    (directory/'office-manifest.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))


def convert_synthetic(name):
    allowed = {'text.pdf', 'table.pdf', 'columns.pdf', 'image.pdf', 'blank.pdf',
               'synthetic.docx', 'synthetic.pptx', 'synthetic.xlsx'}
    if name not in allowed:
        raise ValueError('Only fixed authored fixture names are accepted')
    path = Path.cwd() / 'fixtures' / name
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024*1024:
        raise ValueError('Invalid fixture type/size')
    data = path.read_bytes()
    if len(data) > 1024*1024:
        raise ValueError('Fixture grew beyond size limit')
    from docling.document_converter import DocumentConverter, NativePdfFormatOption
    from docling.datamodel.pipeline_options import NativePdfPipelineOptions
    from docling.datamodel.base_models import InputFormat
    options = NativePdfPipelineOptions(document_timeout=45.0, enable_remote_services=False,
                                       allow_external_plugins=False, generate_picture_images=False,
                                       generate_page_images=False)
    converter = DocumentConverter(allowed_formats=[InputFormat.PDF, InputFormat.DOCX,
                                                  InputFormat.PPTX, InputFormat.XLSX],
                                  format_options={InputFormat.PDF: NativePdfFormatOption(pipeline_options=options)})
    result = converter.convert(path, max_num_pages=5, max_file_size=1024*1024)
    document = result.document
    observation = {'filename': name, 'source_sha256': hashlib.sha256(data).hexdigest(),
                   'status': result.status.value, 'ocr_performed': False,
                   'model_inference_requested': False,
                   'page_count': len(document.pages),
                   'texts': [{'text': item.text, 'label': item.label.value,
                              'provenance': [p.model_dump(mode='json') for p in item.prov]}
                             for item in document.texts],
                   'tables': [t.data.model_dump(mode='json') for t in document.tables],
                   'errors': [str(error) for error in result.errors]}
    encoded = json.dumps(observation)
    if len(encoded.encode()) > 1024*1024:
        raise ValueError('Structured result too large')
    # Exclusive observation file; supervisor still bounds stdout and time.
    with (Path.cwd() / (name + '.result.json')).open('x') as output:
        output.write(encoded+'\n')
    print(encoded)


if __name__ == '__main__':
    if sys.argv[1] == 'network-probe':
        network_probe()
    elif sys.argv[1] == 'import-probe':
        import_probe()
    elif sys.argv[1] == 'generate-office':
        generate_office()
    elif sys.argv[1] == 'convert':
        convert_synthetic(sys.argv[2])
    else:
        raise SystemExit('Unknown trial command')
