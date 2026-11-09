"""Offline lossless report archive plus explicit metadata-only licence inventory."""
import gzip, hashlib, json, pathlib, re, sys
root=pathlib.Path(sys.argv[1]); raw=(root/'pip-report.json').read_bytes(); report=json.loads(raw)
rows=[]
for item in report['install']:
 m=item['metadata']; label=m.get('license_expression')
 raw_license=m.get('license','') or ''
 classifiers=[x for x in m.get('classifier',[]) if x.startswith('License ::')]
 if not label: label={'MIT License':'MIT','Apache':'Apache-2.0','Apache 2.0':'Apache-2.0','Apache 2.0 License':'Apache-2.0','PSFL':'PSF-2.0','ISC License':'ISC'}.get(raw_license,raw_license if len(raw_license)<160 else None)
 rows.append({'name':m['name'],'version':m['version'],'requires_python':m.get('requires_python'), 'wheel_url':item['download_info']['url'],'wheel_sha256_declared':item['download_info']['archive_info']['hashes']['sha256'],'wheel_bytes_hash_verified':False,'metadata_source':f"https://pypi.org/pypi/{m['name']}/{m['version']}/json",'license_expression':m.get('license_expression'),'normalized_metadata_label':label or None,'license_classifiers':classifiers,'raw_license_excerpt':raw_license[:300],'raw_license_truncated':len(raw_license)>300,'raw_license_sha256':hashlib.sha256(raw_license.encode()).hexdigest(),'license_status':'declared metadata; see separate wheel notice inspection, not blanket clearance'})
(root/'resolved-inventory.json').write_text(json.dumps({'package_count':len(rows),'environment':report['environment'],'pip_version':report['pip_version'],'raw_report_sha256':hashlib.sha256(raw).hexdigest(),'artifacts':rows},indent=2)+'\n')
(root/'pip-report.json.gz').write_bytes(gzip.compress(raw,mtime=0))
print(len(rows),hashlib.sha256(raw).hexdigest())
