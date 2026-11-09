"""Offline experiment only: bounded, caller-supplied text snapshots. No file crawler."""
from dataclasses import dataclass
from collections import Counter
import hashlib
import re
import sqlite3

MAX_DOCS = 2048
MAX_DOCUMENT_BYTES = 32768
MAX_CORPUS_BYTES = 8 * 1024 * 1024
MAX_QUERY_BYTES = 1024
MAX_QUERY_TERMS = 32
MAX_RESULTS = 20
# Deliberately basic Unicode word tokens, no stemming, synonyms or stop words.
def tokens(text):
    return re.findall(r'[^\W_]+', text.casefold(), re.UNICODE)

@dataclass(frozen=True)
class Document:
    id: str
    text: str

@dataclass(frozen=True)
class Hit:
    document_id: str
    sha256: str
    start: int
    end: int
    quote: str
    score: float
    # Offsets are Python Unicode code points, NOT bytes or PDF page coordinates.

def query_terms(query):
    if not isinstance(query, str) or len(query.encode('utf-8')) > MAX_QUERY_BYTES:
        raise ValueError('query exceeds bounds or is not text')
    words = list(dict.fromkeys(tokens(query)))
    if len(words) > MAX_QUERY_TERMS:
        raise ValueError('too many query terms')
    return words

class Index:
    def __init__(self, documents, backend='overlap'):
        if backend not in ('overlap', 'fts5'):
            raise ValueError('unknown backend')
        if not isinstance(documents, (tuple, list)) or len(documents) > MAX_DOCS:
            raise ValueError('corpus must be a bounded snapshot')
        self.backend = backend
        self.documents = tuple(documents)
        ids = set()
        total = 0
        for doc in self.documents:
            if not isinstance(doc, Document) or not isinstance(doc.id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', doc.id):
                raise ValueError('invalid document identity')
            if doc.id in ids:
                raise ValueError('duplicate document identity')
            ids.add(doc.id)
            if not isinstance(doc.text, str) or '\0' in doc.text:
                raise ValueError('invalid text')
            size = len(doc.text.encode('utf-8'))
            total += size
            if size > MAX_DOCUMENT_BYTES or total > MAX_CORPUS_BYTES:
                raise ValueError('corpus byte limit exceeded')
        self.digests = [hashlib.sha256(d.text.encode()).hexdigest() for d in self.documents]
        self.counts = [Counter(tokens(d.text)) for d in self.documents]
        self.db = None
        if backend == 'fts5':
            self.db = sqlite3.connect(':memory:')
            try:
                # Same pretokenization as baseline; retain accents and avoid stemming.
                self.db.execute("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='unicode61 remove_diacritics 0')")
                self.db.executemany('INSERT INTO docs(rowid,body) VALUES (?,?)',
                                    ((i+1, ' '.join(tokens(d.text))) for i,d in enumerate(self.documents)))
                self.db.commit()
            except Exception:
                self.db.close()
                raise

    def close(self):
        if self.db is not None:
            self.db.close()

    def search(self, query, k=3):
        if type(k) is not int or not 1 <= k <= MAX_RESULTS:
            raise ValueError('invalid result limit')
        words = query_terms(query)
        if not words:
            return []
        if self.backend == 'overlap':
            scores = [(i, float(sum(count[w] for w in words))) for i,count in enumerate(self.counts)]
            ranked = sorted((v for v in scores if v[1] > 0), key=lambda v:(-v[1], v[0]))[:k]
        else:
            # No raw MATCH operators, SQL interpolation, paths or URL dereferences.
            match = ' OR '.join('"' + w.replace('"', '""') + '"' for w in words)
            ranked = [(rowid-1, -score) for rowid,score in self.db.execute(
                'SELECT rowid,bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score,rowid LIMIT ?', (match,k))]
        hits = []
        for i,score in ranked:
            text = self.documents[i].text
            # Quote exact original text around first token hit; never synthesize answers.
            spans = list(re.finditer(r'[^\W_]+', text, re.UNICODE))
            position = next((m.start() for m in spans if m.group().casefold() in words), 0)
            start = max(0, position-60)
            end = min(len(text), start+320)
            hits.append(Hit(self.documents[i].id, self.digests[i], start, end, text[start:end], score))
        return hits
