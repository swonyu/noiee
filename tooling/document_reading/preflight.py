"""Metadata-only diagnostic. Never imports Docling, parses files, or downloads models."""
import importlib.metadata
import json
import platform
import sys

REVIEWED_VERSION = '2.149.0'


def assess(python_version, machine, versions):
    blockers = []
    if not ((3, 10) <= tuple(python_version[:2]) <= (3, 14)):
        blockers.append('Python is outside the reviewed advertised 3.10–3.14 range.')
    if machine not in ('arm64', 'x86_64'):
        blockers.append('Architecture has not been reviewed.')
    for name in ('docling', 'docling-slim'):
        if versions.get(name) != REVIEWED_VERSION:
            blockers.append(f'{name}=={REVIEWED_VERSION} is not installed in this interpreter.')
    return {
        'kind': 'document-reading-metadata-preflight-v1',
        'python': '.'.join(map(str, python_version)), 'machine': machine,
        'packages': versions, 'metadata_matches_review': not blockers,
        'conversion_verified': False, 'production_ready': False,
        'blockers': blockers,
        'remaining_gates': ['Resolve and audit exact wheels, transitive licences and model artifacts.',
                            'Verify isolated no-network conversion with synthetic fixtures.',
                            'Measure extraction accuracy, resource bounds and process cancellation.'],
    }


def inspect():
    versions = {}
    for name in ('docling', 'docling-slim'):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return assess(sys.version_info[:3], platform.machine(), versions)


if __name__ == '__main__':
    print(json.dumps(inspect(), indent=2))
