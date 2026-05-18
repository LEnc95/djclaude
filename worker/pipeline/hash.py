"""Canonical hashing for dedup across importers and request submissions."""
from __future__ import annotations

import hashlib
import re
import unicodedata

_PUNCT = re.compile(r"[^\w\s]+")
_WS = re.compile(r"\s+")
_PARENS = re.compile(r"\([^)]*\)|\[[^\]]*\]")  # strip "(Remastered)", "[Live]" etc.

_NOISE_WORDS = {
    # commonly inflate dedup misses on YouTube uploads
    "official", "video", "audio", "lyrics", "lyric", "music", "hd", "hq",
    "remaster", "remastered", "version", "stereo", "mono", "explicit",
}


def slug(s: str) -> str:
    """Normalize a title/artist into a comparable ASCII slug.

    Goals: 'The Killers' == 'the killers', 'Mr. Brightside' == 'mr brightside',
    'Song (Official Video)' == 'song'.
    """
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = _PARENS.sub(" ", s)
    s = s.lower()
    s = _PUNCT.sub(" ", s)
    tokens = [t for t in _WS.split(s) if t and t not in _NOISE_WORDS]
    return "-".join(tokens)


def canonical_hash(artist: str, title: str) -> str:
    """Stable hex digest used as `songs.canonical_hash`. Same input → same row."""
    key = f"{slug(artist)}|{slug(title)}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()
