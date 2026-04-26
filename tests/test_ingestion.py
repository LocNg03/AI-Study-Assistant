"""Tests for ingestion.py — file save, chunking, cleanup."""

from pathlib import Path

import pytest

import ingestion


@pytest.fixture
def isolated_uploads(tmp_path, monkeypatch):
    """Point ingestion.upload_dir at a per-test tmp dir; auto-reverts on teardown."""
    monkeypatch.setattr(ingestion, "upload_dir", str(tmp_path))
    return tmp_path


def test_save_uploaded_file_writes_content(isolated_uploads):
    path = ingestion.save_uploaded_file("notes.txt", b"hello world")

    assert Path(path).read_bytes() == b"hello world"
    assert Path(path).parent == isolated_uploads


def test_save_uploaded_file_collision_appends_suffix(isolated_uploads):
    p1 = ingestion.save_uploaded_file("notes.txt", b"first")
    p2 = ingestion.save_uploaded_file("notes.txt", b"second")

    assert p1 != p2
    assert p2.endswith("notes_1.txt")
    assert Path(p1).read_bytes() == b"first"
    assert Path(p2).read_bytes() == b"second"


def test_save_uploaded_file_strips_path_traversal(isolated_uploads):
    """A malicious filename like ../../etc/passwd must not escape upload_dir."""
    path = ingestion.save_uploaded_file("../../../etc/passwd", b"x")

    assert Path(path).name == "passwd"
    assert Path(path).parent == isolated_uploads


def test_load_and_chunk_unsupported_extension(tmp_path):
    p = tmp_path / "image.png"
    p.write_bytes(b"\x89PNG")

    with pytest.raises(ValueError, match="Unsupported file type"):
        ingestion.load_and_chunk(str(p))


def test_load_and_chunk_txt_splits_long_text(tmp_path):
    p = tmp_path / "notes.txt"
    # ~2400 chars forces at least 2 chunks at chunk_size=1000
    p.write_text("hello world " * 200)

    chunks = ingestion.load_and_chunk(str(p))

    assert len(chunks) >= 2
    assert all(c.page_content for c in chunks)


def test_load_and_chunk_txt_short_returns_one_chunk(tmp_path):
    p = tmp_path / "short.txt"
    p.write_text("just a few words")

    chunks = ingestion.load_and_chunk(str(p))

    assert len(chunks) == 1
    assert "just a few words" in chunks[0].page_content


def test_clear_uploads_removes_files(isolated_uploads):
    (isolated_uploads / "a.txt").write_text("x")
    (isolated_uploads / "b.txt").write_text("y")

    ingestion.clear_uploads()

    assert list(isolated_uploads.iterdir()) == []


def test_clear_uploads_missing_dir_is_noop(monkeypatch, tmp_path):
    """clear_uploads on a nonexistent dir must not raise — fresh-install case."""
    missing = tmp_path / "does-not-exist"
    monkeypatch.setattr(ingestion, "upload_dir", str(missing))

    ingestion.clear_uploads()  # should silently return
