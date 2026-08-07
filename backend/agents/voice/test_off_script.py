import unittest

import llm


class OffScriptDetectionTests(unittest.TestCase):
    def test_list_the_items(self):
        self.assertTrue(llm.looks_like_factual_question("list the items"))

    def test_delivery_date_question(self):
        self.assertTrue(llm.looks_like_factual_question("what is the delivery date?"))

    def test_okay_not_off_script(self):
        self.assertFalse(llm.looks_like_factual_question("okay"))

    def test_umm_not_off_script(self):
        self.assertFalse(llm.looks_like_factual_question("umm"))

    def test_hand_screwdriver_not_regex_off_script(self):
        self.assertFalse(llm.looks_like_factual_question("Hand screwdriver"))


if __name__ == "__main__":
    unittest.main()
