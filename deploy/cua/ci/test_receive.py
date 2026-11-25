import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import receive


class ArtifactTest(unittest.TestCase):
    def setUp(self):
        self.files = {name: b"ok" for name in receive.FILES}
        self.run = {"id": 123, "event": "push", "head_branch": "main", "head_sha": "abc",
                    "path": ".github/workflows/ci.yml", "head_repository": {"full_name": receive.REPO}}
        self.unit = {"encoding": "base64", "content": "b2s="}
        self.artifact = {"name": "cua-vps-123-1", "expired": False,
                         "workflow_run": {"id": 123, "head_sha": "abc"}}

    def verify(self, corrupt=False):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            for name, data in self.files.items():
                archive.writestr(name, data)
        data = stream.getvalue()
        self.artifact["digest"] = "sha256:" + hashlib.sha256(data).hexdigest()
        with patch.object(receive, "github", side_effect=[self.artifact, self.run, {"object": {"sha": "abc"}}, self.unit]):
            return receive.verified_archive("1", data + b"!" if corrupt else data)

    def test_only_trusted_main_archive(self):
        self.assertEqual(self.verify(), ("abc", self.files))
        with self.assertRaises(ValueError):
            self.verify(corrupt=True)
        for field, value in [("event", "pull_request"), ("head_branch", "other"), ("head_sha", "past"),
                             ("path", ".github/workflows/other.yml"), ("head_repository", {"full_name": "fork/cs_agent"})]:
            with self.subTest(field=field), patch.dict(self.run, {field: value}), self.assertRaises(ValueError):
                self.verify()
        with patch.dict(self.unit, {"content": ""}), self.assertRaises(ValueError):
            self.verify()
        self.files["../unexpected"] = b"extra"
        with self.assertRaises(ValueError):
            self.verify()


class InstallTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.files = {name: self.root / name for name in receive.FILES}
        for path in self.files.values():
            path.write_bytes(b"old")
        self.new = dict.fromkeys(self.files, b"new")
        self.enterContext(patch.object(receive, "ROOT", self.root))
        self.enterContext(patch.object(receive, "FILES", self.files))
        self.restart = self.enterContext(patch.object(receive, "restart"))
        self.health = self.enterContext(patch.object(receive, "healthy"))

    def test_new_commit_same_contents_is_idempotent(self):
        receive.install("first", self.new)
        receive.install("next", self.new)
        self.restart.assert_called_once()
        self.assertEqual((self.root / ".ci-release").read_text(), "next\n")
        self.assertEqual([p.read_bytes() for p in self.files.values()], list(self.new.values()))

    def test_rollback_and_interrupted_recovery(self):
        self.health.side_effect = [RuntimeError("disconnected"), RuntimeError("rollback interrupted")]
        with self.assertRaisesRegex(RuntimeError, "rollback interrupted"):
            receive.install("first", self.new)
        self.assertTrue((self.root / ".ci-rollback/pending").exists())
        self.assertFalse((self.root / ".ci-release").exists())
        self.assertTrue(all(path.read_bytes() == b"old" for path in self.files.values()))
        self.health.side_effect = None
        receive.install("retry", self.new)
        self.assertFalse((self.root / ".ci-rollback/pending").exists())
        self.assertEqual((self.root / ".ci-release").read_text(), "retry\n")
