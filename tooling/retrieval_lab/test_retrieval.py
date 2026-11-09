import hashlib
import unittest
from fixtures import DOCUMENTS
from retrieval import Index, Document, MAX_DOCS, MAX_CORPUS_BYTES, MAX_DOCUMENT_BYTES

class RetrievalTests(unittest.TestCase):
    def test_fts_available(self):
        index = Index([], 'fts5')
        index.close()

    def test_grounding_and_reproducibility(self):
        docs = {d.id:d for d in DOCUMENTS}
        for backend in ('overlap', 'fts5'):
            index = Index(DOCUMENTS, backend)
            self.addCleanup(index.close)
            for query in ('Maple backup', 'café ferme', 'مكتبة النور', 'Ignore prior instructions'):
                hits = index.search(query)
                self.assertTrue(hits)
                self.assertEqual(hits, index.search(query))
                for hit in hits:
                    original = docs[hit.document_id].text
                    self.assertEqual(hit.quote, original[hit.start:hit.end])
                    self.assertEqual(hit.sha256, hashlib.sha256(original.encode()).hexdigest())
                    self.assertLessEqual(len(hit.quote), 320)

    def test_empty_absent_and_literal_query_syntax(self):
        for backend in ('overlap', 'fts5'):
            index = Index(DOCUMENTS, backend)
            self.addCleanup(index.close)
            for query in ('', '"*():', 'quasar zeppelin', 'NEAR("quasar", "zeppelin")'):
                self.assertEqual([], index.search(query))
            self.assertTrue(index.search('"Maple" OR (backup*)'))

    def test_snapshot_not_mutable_list(self):
        docs = [Document('one', 'first entry')]
        index = Index(docs)
        docs.clear()
        self.assertEqual('one', index.search('first')[0].document_id)

    def test_changed_content_changes_digest(self):
        first = Index([Document('one', 'first entry')]).search('entry')[0]
        second = Index([Document('one', 'second entry')]).search('entry')[0]
        self.assertNotEqual(first.sha256, second.sha256)

    def test_duplicate_invalid_identity_and_text(self):
        for docs in ([Document('x','a'), Document('x','b')], [Document('../x','a')], [Document('x','a\0b')], [Document('x',None)]):
            with self.assertRaises(ValueError):
                Index(docs)

    def test_limits(self):
        with self.assertRaises(ValueError):
            Index([Document('x', 'a')]*(MAX_DOCS+1))
        with self.assertRaises(ValueError):
            Index([Document('x','a'*(MAX_DOCUMENT_BYTES+1))])
        with self.assertRaises(ValueError):
            Index([Document(f'd{i}', 'a'*MAX_DOCUMENT_BYTES) for i in range(MAX_CORPUS_BYTES//MAX_DOCUMENT_BYTES+1)])
        index = Index([])
        for query in ('a'*1025, ' '.join(f't{i}' for i in range(33))):
            with self.assertRaises(ValueError):
                index.search(query)
        for k in (0,21,True,1.5):
            with self.assertRaises(ValueError):
                index.search('a',k)

    def test_no_synonym_claim(self):
        for backend in ('overlap','fts5'):
            index = Index(DOCUMENTS,backend)
            self.addCleanup(index.close)
            self.assertEqual([], index.search('dining allowance ceiling'))
            # Missing-answer false positive is an explicitly observed limitation.
            self.assertTrue(index.search('Atlas telescope warranty lifetime'))

    def test_same_terms_do_not_imply_same_rank(self):
        overlap,fts = Index(DOCUMENTS),Index(DOCUMENTS,'fts5')
        self.addCleanup(fts.close)
        self.assertEqual('return_glossary', overlap.search('Atlas telescope return policy')[0].document_id)
        self.assertEqual('atlas_return', fts.search('Atlas telescope return policy')[0].document_id)

if __name__ == '__main__':
    unittest.main(verbosity=2)
