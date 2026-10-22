"""Email moderators about new "request to join" submissions on the govote2026 map.

Run hourly by the Windows Task Scheduler task "govote2026_join_requests" (election week only).
Each run asks Supabase for open requests that were not reported yet (moderator_new_requests marks them
reported); if there are any, one email lists them all. If the email fails, they go back in the queue.

Settings come from .env files, never from this (public) repo:
    Betakerem/.env               GOVOTE_MODERATOR_PASSWORD, GOVOTE_NOTIFY_EMAILS (comma-separated)
    MyPythonScripts/.env         EMAIL_PASSWORD for the lobby bot Gmail account (same as the pmo scripts)
"""
import html
import os
import smtplib
import ssl
import sys
import traceback
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# ---- settings ----
REPO = Path(__file__).resolve().parent.parent
ENV_FILES = [REPO / '.env', Path.home() / 'PycharmProjects' / 'MyPythonScripts' / '.env']
SUPABASE_URL = 'https://plsyyconetnlpkpspaje.supabase.co'
SUPABASE_KEY = 'sb_publishable_DG7VvWfcdCT1v8XUpyDBUQ_J4XkriA4'  # publishable key, same as govote2026/config.js
MODERATORS_URL = 'https://betakerem.org/govote2026/moderators/'
SLOT = {'10-12': '10–12', '12-14': '12–14', '14-16': '14–16', '16-18': '16–18'}
TZ = ZoneInfo('Asia/Jerusalem')

for env in ENV_FILES:
    load_dotenv(env)


class Mail:
    """Same Gmail sender as pmo/gov_il_common.Mail."""

    def __init__(self):
        self.sender_mail = 'thelobbybot99@gmail.com'
        self.password = os.getenv('EMAIL_PASSWORD')
        self.smtp_server_domain_name = 'smtp.gmail.com'
        self.port = 465

    def send(self, emails, html_content, subject):
        try:
            service = smtplib.SMTP_SSL(self.smtp_server_domain_name, self.port, context=ssl.create_default_context())
            service.login(self.sender_mail, self.password)
            for email in emails:
                mail = MIMEMultipart('alternative')
                mail['Subject'] = subject
                mail['From'] = self.sender_mail
                mail['To'] = email
                mail.attach(MIMEText(html_content, 'html'))
                service.sendmail(self.sender_mail, email, mail.as_string())
                print(f'Email sent to {email}')
            service.quit()
            return True
        except Exception as e:
            print(f'Error sending email: {e}')
            return False


def rpc(fn, **args):
    r = requests.post(f'{SUPABASE_URL}/rest/v1/rpc/{fn}', json=args, timeout=60,
                      headers={'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'})
    r.raise_for_status()
    data = r.json()
    if not data.get('ok'):
        raise RuntimeError(f'{fn}: {data.get("error")}')
    return data


def phone_fmt(p):
    return f'{p[:3]}-{p[3:]}' if p and len(p) == 10 else (p or '')


def local_time(ts):
    return datetime.fromisoformat(ts).astimezone(TZ).strftime('%d/%m %H:%M')


def build_email_html(reqs, open_count):
    e = lambda s: html.escape(str(s or ''))
    tel = lambda p: f'<a href="tel:{e(p)}">{e(phone_fmt(p))}</a>' if p else ''
    rows = ''.join(f'''<tr>
        <td>{e(r["block_id"])}<br>{e(r["label"])}</td>
        <td><b>{e(r["names"])}</b><br>{tel(r["phone"])}{f"<br><i>{e(r['note'])}</i>" if r.get("note") else ""}</td>
        <td>{e(r["owner_names"]) or "<i>הבלוק שוחרר</i>"}<br>{tel(r["owner_phone"])}<br>
            {e(", ".join(SLOT.get(s, s) for s in r.get("owner_slots") or []))}</td>
        <td>{local_time(r["created_at"])}</td></tr>''' for r in reqs)
    cell = 'style="border:1px solid #ddd;padding:6px 8px;text-align:right;vertical-align:top"'
    rows = rows.replace('<td>', f'<td {cell}>')
    return f'''<html><body dir="rtl" style="font-family:Arial,sans-serif">
        <h2>{len(reqs)} בקשות חדשות להצטרף לבלוקים</h2>
        <p>התקשרו למבקשים ולמתנדבי הבלוק וחברו ביניהם, ואז סמנו "טופל" ב<a href="{MODERATORS_URL}">עמוד המנהלים</a>.
           סה"כ בקשות פתוחות: {open_count}.</p>
        <table style="border-collapse:collapse">
          <tr><th {cell}>בלוק</th><th {cell}>מבקש/ת</th><th {cell}>מתנדבי הבלוק</th><th {cell}>נשלחה</th></tr>
          {rows}
        </table>
        <p style="color:#888">המידע פרטי – אין להעביר מספרי טלפון מחוץ לצוות.</p>
    </body></html>'''


def main():
    password = os.getenv('GOVOTE_MODERATOR_PASSWORD')
    recipients = [x.strip() for x in os.getenv('GOVOTE_NOTIFY_EMAILS', '').split(',') if x.strip()]
    if not password or not recipients:
        sys.exit('GOVOTE_MODERATOR_PASSWORD and GOVOTE_NOTIFY_EMAILS must be set in ' + str(ENV_FILES[0]))
    mail = Mail()
    try:
        data = rpc('moderator_new_requests', p_password=password)
        reqs = data['requests']
        print(f'{datetime.now(TZ):%Y-%m-%d %H:%M} new requests: {len(reqs)}, open: {data["open"]}')
        if not reqs:
            return
        subject = f'בית הכרם יוצאת להצביע: {len(reqs)} בקשות חדשות להצטרף לבלוק'
        if not mail.send(recipients, build_email_html(reqs, data['open']), subject):
            rpc('moderator_unnotify_requests', p_password=password, p_ids=[r['id'] for r in reqs])
            print('email failed; requests returned to the queue for the next run')
    except Exception as e:
        print(traceback.format_exc())
        mail.send(recipients[:1], f'<pre>{html.escape(traceback.format_exc())}</pre>',
                  f'govote2026 join-request check failed: {e}'[:150])
        sys.exit(1)


if __name__ == '__main__':
    main()
