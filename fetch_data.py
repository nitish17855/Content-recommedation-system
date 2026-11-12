import requests, time
from collections import deque
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from urllib.parse import urljoin, urlparse

BASE = "https://www.nspglobalservices.com/"
BASE_HOST = urlparse(BASE).netloc.removeprefix("www.")
OUT_FILE = "NSP_SITE_2.md"

seen = set()
queued = {BASE}
queue = deque([BASE])
out = []

while queue:
    url = queue.popleft().split("#")[0].strip()
    host = urlparse(url).netloc.removeprefix("www.")
    if not url or url in seen or host != BASE_HOST:
        continue
    seen.add(url)
    print(f"[{len(seen)}] Fetching: {url}", flush=True)
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            continue
        soup = BeautifulSoup(r.text, "html.parser")
        for a in soup.find_all("a", href=True):
            next_url = urljoin(url, a["href"]).split("#")[0].strip()
            next_host = urlparse(next_url).netloc.removeprefix("www.")
            if next_url and next_host == BASE_HOST and next_url not in seen and next_url not in queued:
                queued.add(next_url)
                queue.append(next_url)
        for t in soup(["script", "style", "nav", "footer", "header"]):
            t.decompose()
        out.append(f"# {url}\n\n{md(str(soup.body or soup))}\n\n---\n")
    except Exception as e:
        print(f"Error fetching {url}: {e}", flush=True)
    time.sleep(1)

with open(OUT_FILE, "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print(f"Done! Saved {len(out)} pages ({len(seen)} visited) to {OUT_FILE}", flush=True)
