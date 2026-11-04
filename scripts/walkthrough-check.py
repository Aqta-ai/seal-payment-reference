#!/usr/bin/env python3
"""Drives the walkthrough in Chrome against the scripted preview, with the controls a person uses.
No model is called. Usage: python3 scripts/walkthrough-check.py [screenshot directory]"""
import os, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / '.review-shots')
SHOTS.mkdir(parents=True, exist_ok=True)
VIEWPORTS = {'phone': dict(width=390, height=844), 'desktop': dict(width=1440, height=900)}
problems = []
PAUSE_MS = 1500 # Each scripted model call takes this long, well inside the 2.5 second run poll.

def serve(mode, port):
    process = subprocess.Popen(['node', 'scripts/preview-scripted.mjs'], cwd=ROOT, env={**os.environ, 'PREVIEW_MODE': mode, 'PORT': str(port), 'PREVIEW_PAUSE_MS': str(PAUSE_MS)}, stdout=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/config', timeout=1); return process
        except Exception: time.sleep(0.1)
    raise RuntimeError('The preview did not start.')

LAYOUT = """() => {
  const width = document.documentElement.clientWidth, tour = document.getElementById('tour');
  const focus = document.querySelector('.tour-focus');
  const box = tour.hidden ? null : tour.getBoundingClientRect();
  const wide = [...document.querySelectorAll('#tour, #tour *')].filter(node => { const r = node.getBoundingClientRect(); return r.width && (r.right > width + 1 || r.left < -1); }).map(node => node.id || node.className);
  const f = focus && focus.getBoundingClientRect();
  return { page: document.documentElement.scrollWidth, width, wide, tourHeight: box && box.height, tourTop: box && box.top, focus: focus && focus.id,
    focusVisible: !f || (f.bottom > (box ? box.bottom : 0) && f.top < innerHeight) };
}"""

def check(page, viewport, flow, name, step=None, contains=None):
    if step: page.wait_for_function('s => document.getElementById("tour-step").textContent.startsWith(s)', arg=f'Step {step} ')
    if contains:
        page.wait_for_function('s => document.getElementById("tour-text").textContent.includes(s)', arg=contains)
    page.wait_for_timeout(120)
    layout = page.evaluate(LAYOUT)
    label = f'{viewport}/{flow}/{name}'
    if layout['page'] > layout['width']: problems.append(f"{label}: page {layout['page']} wider than {layout['width']}")
    if layout['wide']: problems.append(f"{label}: tour overflow {layout['wide']}")
    if not layout['focusVisible']: problems.append(f"{label}: target {layout['focus']} off screen or under the bar")
    if layout['tourTop'] is not None and layout['tourTop'] < -1: problems.append(f"{label}: bar scrolled away")
    text = page.locator('#tour').inner_text() if page.locator('#tour').is_visible() else '(tour closed)'
    print(f"{label} [{layout['tourHeight']}px bar, target {layout['focus']}]: {' | '.join(text.splitlines())}")
    page.screenshot(path=str(SHOTS / f'{viewport}-{flow}-{name}.png'))

def while_busy(page, viewport, flow, name, step, contains, hint=None):
    """The words shown during a scripted call. Must change straight away, not at the next poll or when the call returns."""
    label = f'{viewport}/{flow}/{name}'
    started = time.monotonic()
    try:
        page.wait_for_function('([step, text, hint]) => document.getElementById("tour-step").textContent.startsWith(step) && document.getElementById("tour-text").textContent.includes(text) && (!hint || document.getElementById("tour-hint").textContent.includes(hint))', arg=[f'Step {step} ', contains, hint], timeout=PAUSE_MS - 300)
    except Exception:
        problems.append(f'{label}: bar did not show "{hint or contains}" within {PAUSE_MS - 300} ms; it says: {page.locator("#tour").inner_text()!r}')
        return
    print(f'{label} [{int((time.monotonic() - started) * 1000)} ms]: {" | ".join(page.locator("#tour").inner_text().splitlines())}')
    page.screenshot(path=str(SHOTS / f'{viewport}-{flow}-{name}.png'))

def open_tour(page, base, viewport, flow):
    page.goto(base + '/')
    page.locator('#tour-start').click()
    check(page, viewport, flow, '1-opening', 1, 'approved for the account ending 1280. A later message asks to pay 1289.')

def to_proposal(page, viewport, flow):
    page.locator('#start-conflict').click()
    page.wait_for_selector('#analyse-documents:visible')
    check(page, viewport, flow, '1b-saved', 1, 'A later message asks to pay 1289')
    page.locator('#analyse-documents').click()
    while_busy(page, viewport, flow, '1b-analysing', 1, 'A later message asks to pay 1289', 'The model is reading the documents.')

def full_run(page, base, viewport, flow, acted):
    open_tour(page, base, viewport, flow)
    to_proposal(page, viewport, flow)
    page.wait_for_selector('#continue-proposal:visible')
    check(page, viewport, flow, '1c-proposal', 1)
    page.locator('#continue-proposal').click()
    while_busy(page, viewport, flow, '2a-working', 2, 'Its steps will appear when this run finishes.')
    check(page, viewport, flow, '2-agent-acted', 2, acted)
    page.locator('#tour-next').click()
    check(page, viewport, flow, '3-decide', 3, 'Check the exact details, then approve this one payment.')
    hint = page.locator('#tour-hint').inner_text()
    if 'The original approval was for the account ending 1280.' not in hint or 'you accept these exact details' not in hint: problems.append(f'{viewport}/{flow}/3-decide: hint reads {hint!r}')
    page.locator('#confirm').check()
    page.locator('#approve').click()
    page.wait_for_selector('#resume:visible')
    check(page, viewport, flow, '3b-approved', 3, 'Approved for this one payment.')
    page.locator('#resume').click()
    while_busy(page, viewport, flow, '3c-using', 3, 'Approved for this one payment.', 'The agent is using the approval.')
    check(page, viewport, flow, '4-one-payment', 4, 'One payment. Nothing else moved.')
    page.locator('#tour-next').click()
    check(page, viewport, flow, '5-break-it', 5, 'Now try to break it')
    page.locator('#check-edited-copy').click()
    page.wait_for_function('() => document.getElementById("tour-hint").textContent.includes("edited copy was rejected")')
    check(page, viewport, flow, '5b-edited', 5)
    page.locator('#check-repeat-run').click()
    page.wait_for_function('() => document.getElementById("tour-hint").textContent.includes("still one payment")')
    check(page, viewport, flow, '5c-repeat', 5)
    assert page.locator('#ledger-count').inner_text() == '1 payment'
    page.get_by_role('link', name='Use your own test documents').click()
    page.wait_for_selector('#document-entry:visible')
    assert not page.locator('#tour').is_visible()
    check(page, viewport, flow, '6-own-documents')

def clarify(page, base, viewport, flow):
    open_tour(page, base, viewport, flow)
    to_proposal(page, viewport, flow)
    check(page, viewport, flow, '2-question', 2, 'The model asked a question')
    page.get_by_role('link', name='Start a fresh case').click()
    check(page, viewport, flow, '3-fresh-case', 1, 'A later message asks to pay 1289')

def words(page, base, viewport, flow):
    open_tour(page, base, viewport, flow)
    to_proposal(page, viewport, flow)
    page.wait_for_selector('#continue-proposal:visible')
    page.locator('#continue-proposal').click()
    while_busy(page, viewport, flow, '2a-working', 2, 'Its steps will appear when this run finishes.')
    check(page, viewport, flow, '2-words', 2, 'answered in words')

with sync_playwright() as driver:
    browser = driver.chromium.launch(channel='chrome', headless=True)
    flows = [('refuse', lambda *a: full_run(*a, 'The check refused it')), ('direct', lambda *a: full_run(*a, 'did not try to pay')), ('clarify', clarify), ('text', words)]
    port = 4190
    for flow, drive in flows:
        for viewport, size in VIEWPORTS.items():
            port += 1
            server = serve(flow, port)
            context = browser.new_context(viewport=size, is_mobile=viewport == 'phone', has_touch=viewport == 'phone', device_scale_factor=2 if viewport == 'phone' else 1, accept_downloads=True)
            page = context.new_page()
            page.on('console', lambda m, l=f'{viewport}/{flow}': problems.append(f'{l}: console {m.text}') if m.type == 'error' and '409' not in m.text else None)
            page.on('pageerror', lambda e, l=f'{viewport}/{flow}': problems.append(f'{l}: {e}'))
            try: drive(page, f'http://127.0.0.1:{port}', viewport, flow)
            except Exception as error:
                problems.append(f'{viewport}/{flow}: {type(error).__name__} {str(error)[:300]}')
                page.screenshot(path=str(SHOTS / f'{viewport}-{flow}-FAILED.png'))
            finally:
                context.close(); server.terminate(); server.wait()
    browser.close()
print('\nProblems:' if problems else '\nNo problems.')
for problem in problems: print(' -', problem)
sys.exit(1 if problems else 0)
