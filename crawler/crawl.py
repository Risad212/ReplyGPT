"""Weekly website reader.

Reads crawler/sites.json, walks each sitemap, extracts clean text from every page
with trafilatura, and sends each page to POST {API_URL}/api/docs with source_url set,
so re-running replaces the old version of a page.

Environment: API_URL (for example https://your-site.pages.dev), TEAM_KEY.
Optional: MAX_PAGES (default 300 per site), DELAY (seconds between requests, default 1).
"""
import json
import os
import sys
import time
import urllib.robotparser
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

import requests
import trafilatura

UA = "AskDeskCrawler/1.0 (+support knowledge base updater)"
MIN_CHARS = 200


def sitemap_urls(url, depth=0):
    """Return page URLs from a sitemap or sitemap index."""
    if depth > 3:
        return []
    r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    locs = [e.text.strip() for e in root.iter() if e.tag.endswith("}loc") or e.tag == "loc"]
    if root.tag.endswith("sitemapindex"):
        pages = []
        for child in locs:
            pages.extend(sitemap_urls(child, depth + 1))
        return pages
    return locs


def robots_for(url):
    p = urlparse(url)
    rp = urllib.robotparser.RobotFileParser()
    rp.set_url(f"{p.scheme}://{p.netloc}/robots.txt")
    try:
        rp.read()
    except Exception:
        return None
    return rp


def main():
    api = os.environ.get("API_URL", "").rstrip("/")
    key = os.environ.get("TEAM_KEY", "")
    if not api or not key:
        print("Set API_URL and TEAM_KEY.")
        return 1
    max_pages = int(os.environ.get("MAX_PAGES", "300"))
    delay = float(os.environ.get("DELAY", "1"))
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "sites.json"), encoding="utf-8") as f:
        sites = json.load(f)

    sent = skipped = failed = 0
    for site in sites:
        plugin = site.get("plugin", "")
        print(f"== {plugin or 'shared'}: {site['sitemap']}")
        try:
            pages = sitemap_urls(site["sitemap"])[:max_pages]
        except Exception as e:
            print(f"   could not read sitemap: {e}")
            failed += 1
            continue
        robots = robots_for(site["sitemap"])
        for page in pages:
            if robots and not robots.can_fetch(UA, page):
                skipped += 1
                continue
            try:
                html = requests.get(page, headers={"User-Agent": UA}, timeout=30).text
                text = trafilatura.extract(html, include_comments=False, include_tables=True) or ""
                if len(text) < MIN_CHARS:
                    skipped += 1
                    continue
                meta = trafilatura.extract_metadata(html)
                title = (meta.title if meta and meta.title else page)[:200]
                r = requests.post(
                    f"{api}/api/docs",
                    headers={"Authorization": f"Bearer {key}"},
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
