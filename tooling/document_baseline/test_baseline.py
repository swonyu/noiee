import tempfile
import unittest
from pathlib import Path
from run import assess, run

class BaselineTests(unittest.TestCase):
    def test_empty_does_not_pass_text(self):
        empty = {name: {'pages': [{'text': ''}]} for name in ('text', 'table', 'columns', 'image', 'blank')}
        result = assess(empty)
        self.assertFalse(result['memo_all_expected_lines'])
        self.assertFalse(result['table_all_expected_row_text'])
        self.assertFalse(result['columns_column_major'])
        self.assertFalse(result['ocr_performed'])

    def test_column_order_is_not_bag_of_words(self):
        empty = {name: {'pages': [{'text': ''}]} for name in ('text', 'table', 'columns', 'image', 'blank')}
        empty['columns']['pages'][0]['text'] = 'LEFT FIRST RIGHT FIRST\nLEFT SECOND RIGHT SECOND'
        self.assertFalse(assess(empty)['columns_column_major'])
        empty['columns']['pages'][0]['text'] = 'LEFT FIRST\nLEFT SECOND\nRIGHT FIRST\nRIGHT SECOND'
        self.assertTrue(assess(empty)['columns_column_major'])

    def test_timeout(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(TimeoutError):
                run(['/bin/sleep', '10'], Path(temp), 'timeout', 0.05)

    def test_nonzero_is_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            result, _ = run(['/usr/bin/false'], Path(temp), 'failure')
            self.assertEqual(result['exit_code'], 1)

if __name__ == '__main__': unittest.main()
