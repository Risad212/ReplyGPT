"""Weekly website reader.

Reads crawler/sites.json, walks each sitemap, extracts clean text from every page
with trafilatura, and sends each page to POST {API_URL}/api/docs with source_url set,
so re-running replaces the old version of a page.

Environment: API_URL (for example https://your-site.pages.dev). TEAM_KEY is optional.
Optional: MAX_PAGES (default 300 per site), DELAY (seconds between requests, default 1).
"""
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.robotparser
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlparse

import requests
import trafilatura

UA = "AskDeskCrawler/1.0 (+support knowledge base updater)"
MIN_CHARS = 200
NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
HREF_RE = re.compile(r'href="([^"]+)"')


def sitemap_root(content):
    """Parse a sitemap, handling gzip."""
    if content[:2] == b"\x1f\x8b":
        content = gzip.decompress(content)
    return ET.fromstring(content)


def sitemap_urls(url, depth=0):
    """Return page URLs from a sitemap or sitemap index."""
    if depth > 3:
        return []
    r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    root = sitemap_root(r.content)
    locs = [e.text.strip() for e in root.iter(NS + "loc") if e.text]
    if not locs:  # sitemap without the standard xmlns
        locs = [e.text.strip() for e in root.iter() if e.tag.endswith("loc") and e.text]
    if root.tag in (NS + "sitemapindex", "sitemapindex"):
        pages = []
        for child in locs:
            pages.extend(sitemap_urls(child, depth + 1))
        return pages
    return locs


def robots_for(url):
    """Read robots.txt with requests (urllib's default agent is often blocked)."""
    p = urlparse(url)
    rp = urllib.robotparser.RobotFileParser()
    try:
        r = requests.get(f"{p.scheme}://{p.netloc}/robots.txt", headers={"User-Agent": UA}, timeout=30)
        if r.status_code >= 400:
            return None
        rp.parse(r.text.splitlines())
        return rp
    except Exception:
        return None


def main():
    api = os.environ.get("API_URL", "").rstrip("/")
    key = os.environ.get("TEAM_KEY", "")
    dry = os.environ.get("DRY_RUN") == "1"
    if not api and not dry:
        print("Set API_URL (or DRY_RUN=1 to test without sending).")
        return 1
    max_pages = int(os.environ.get("MAX_PAGES", "300"))
    delay = float(os.environ.get("DELAY", "1"))
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "sites.json"), encoding="utf-8") as f:
        sites = json.load(f)

    sent = skipped = failed = 0
    for site in sites:
        plugin = site.get("plugin", "")
        include = site.get("include", [])
        exclude = site.get("exclude", [])
        source = site.get("pages") or site.get("sitemap")
        print(f"== {plugin or 'shared'}: {source}")
        try:
            if site.get("pages"):
                pages = list(site["pages"])
            else:
                pages = sitemap_urls(site["sitemap"])
        except Exception as e:
            print(f"   could not read sitemap: {e}")
            failed += 1
            continue
        pages = [
            u for u in pages
            if (not include or any(s in u for s in include))
            and not any(s in u for s in exclude)
        ][:max_pages]
        robots = robots_for(site.get("sitemap") or (site.get("pages") or [""])[0])

        follow = site.get("follow")
        if follow:
            pat = re.compile(follow)
            seen = set(pages)
            extra = []
            for p in pages:
                if robots and not robots.can_fetch(UA, p):
                    continue
                try:
                    res = requests.get(p, headers={"User-Agent": UA}, timeout=30)
                    res.raise_for_status()
                    for link in HREF_RE.findall(res.text):
                        u = urljoin(p, link)
                        if pat.match(u) and u not in seen:
                            seen.add(u)
                            extra.append(u)
                except Exception:
                    pass
                time.sleep(delay)
            print(f"   found {len(extra)} linked pages")
            pages = (pages + extra)[:max_pages]

        for page in pages:
            if robots and not robots.can_fetch(UA, page):
                skipped += 1
                continue
            try:
                res = requests.get(page, headers={"User-Agent": UA}, timeout=30)
                res.raise_for_status()
                if not res.encoding or res.encoding.lower() in ("iso-8859-1", "us-ascii"):
                    res.encoding = "utf-8"
                html = res.text
                text = trafilatura.extract(html, include_comments=False, include_tables=True) or ""
                if len(text) < MIN_CHARS:
                    skipped += 1
                    continue
                meta = trafilatura.extract_metadata(html)
                title = (meta.title if meta and meta.title else page)[:200]
                if dry:
                    sent += 1
                    print(f"   dry {len(text)} chars | {title} | {page}")
                    continue
                r = requests.post(
                    f"{api}/api/docs",
                    headers={"Authorization": f"Bearer {key}"} if key else {},
                    json={"title": title, "plugin": plugin, "source_url": page, "text": text},
                    timeout=60,
                )
                r.raise_for_status()
                sent += 1
                print(f"   ok  {page}")
            except Exception as e:
                failed += 1
                print(f"   FAIL {page}: {e}")
            time.sleep(delay)

    print(f"Done. Saved {sent}, skipped {skipped}, failed {failed}.")
    return 1 if failed and not sent else 0


if __name__ == "__main__":
    sys.exit(main())
