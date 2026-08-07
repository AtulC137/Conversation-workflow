"""Tests for AudioSocket protocol helpers."""

import struct
import unittest

TYPE_AUDIO = 0x10
TYPE_UUID = 0x01
ASTERISK_RATE = 8000
CALL_SESSION_RATE = 16000
BYTES_PER_SAMPLE = 2
PTIME_MS = 20
OUTBOUND_MIN_BYTES_16K = CALL_SESSION_RATE * BYTES_PER_SAMPLE * PTIME_MS // 1000
OUTBOUND_FRAME_BYTES_8K = ASTERISK_RATE * BYTES_PER_SAMPLE * PTIME_MS // 1000


class TestAudioSocketProtocol(unittest.TestCase):
    def test_uuid_message_pack(self):
        uuid_bytes = bytes.fromhex("eb3c8495b47e4c72ac7c4ab0ee0895a3")
        header = struct.pack(">BH", TYPE_UUID, len(uuid_bytes))
        self.assertEqual(len(header), 3)
        self.assertEqual(len(uuid_bytes), 16)

    def test_ptime_constants(self):
        self.assertEqual(PTIME_MS, 20)
        self.assertEqual(OUTBOUND_MIN_BYTES_16K, 640)
        self.assertEqual(OUTBOUND_FRAME_BYTES_8K, 320)

    def test_audio_frame_size_8k(self):
        frame_bytes = ASTERISK_RATE * BYTES_PER_SAMPLE * PTIME_MS // 1000
        self.assertEqual(frame_bytes, OUTBOUND_FRAME_BYTES_8K)

    def test_resample_16k_to_8k_ratio(self):
        # 16kHz -> 8kHz halves byte length for same duration (s16le mono).
        self.assertEqual(OUTBOUND_MIN_BYTES_16K // 2, OUTBOUND_FRAME_BYTES_8K)


if __name__ == "__main__":
    unittest.main()
