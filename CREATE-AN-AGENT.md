# Create an Agent - מדריך למפעילים

מדריך להקמת סוכן חדש ללקוח.

## דרישות מקדימות

- שרת עם Docker (VPS)
- דומיין עם גישת DNS
- WhatsApp על הטלפון של הלקוח

## שלב 1: הכנת השרת

### אפשרות א׳ - Hetzner CX23 (מומלץ)

1. צור שרת **CX23** (2 vCPU, 4GB RAM, IPv4) - כ-€5.99/חודש
2. מיקום: Falkenstein (FSN) או Helsinki (HEL)
3. בחר Ubuntu 22.04
4. הוסף מפתח SSH

```bash
# התחבר לשרת
ssh root@your-server-ip

# התקן Docker
curl -fsSL https://get.docker.com | sh
```

### אפשרות ב׳ - חלופות אם CX23 אזל

| ספק | תוכנית | מפרט |
|-----|--------|------|
| OVH | VPS-1 (2027) | 2 vCPU / 4GB RAM |
| Netcup | VPS 500 G12 | 2 vCPU / 4GB RAM |

### אפשרות ג׳ - Kamatera (ישראל)

למי שצריך שרת בישראל:
- צור שרת Type A (2 vCPU, 4GB RAM) במיקום Tel Aviv
- יקר יותר מ-Hetzner אבל לייטנסי טוב יותר לישראל

### דרישות חובה

| דרישה | סיבה |
|-------|------|
| **4 GB RAM** | Pi runtime + WhatsApp צריכים מקום |
| **IPv4** | WhatsApp Web לא עובד על IPv6 בלבד |
| **פורטים 80+443** | Caddy לצורך HTTPS |
| **Always-on** | WhatsApp session דורש חיבור רציף |
| **Docker Compose** | אורקסטרציה של ה-stack |

### אל תשתמשו ב-

- **VPS עם 1GB RAM** - יקרוס מ-OOM
- **IPv6-only** - בעיות חיבור WhatsApp
- **Serverless / Sleep** (Fly.io sleep, CF Workers) - WhatsApp צריך socket קבוע
- **Ephemeral disk** - session data חייב להישמר
- **Oracle Always Free** - idle reclaim לא צפוי, בעיות IPv4

## שלב 2: הגדרת DNS

הצבע שני A records לאותו שרת — הדומיין של הסוכן ו-host נפרד לקונסולת Open Connector (ה-SPA לא יכול לרוץ תחת `/connector/` על ה-apex):

```
A    agent.example.com          → 1.2.3.4
A    console.agent.example.com  → 1.2.3.4
```

אם משתמשים ב-Cloudflare — כבו את ה-proxy (עננה אפורה) כדי ש-Caddy יוכל להנפיק תעודות בעצמו.

המתן להתפשטות DNS (עד 48 שעות, בדרך כלל דקות).

## שלב 3: שכפול והגדרה

```bash
# שכפל את הריפו
git clone https://github.com/yishaik/desk-agent.git
cd desk-agent

# צור קובץ סביבה
cp .env.example .env

# ערוך את ההגדרות
nano .env
```

### הגדרות חובה ב-.env

```bash
# טוקן גישה לממשק (צור אקראי)
PAIR_TOKEN=$(openssl rand -hex 32)

# מפתח הצפנה לסיסמאות
CONNECTOR_ENCRYPTION_KEY=$(openssl rand -hex 32)

# הדומיין שלך (apex / agent host)
DOMAIN=agent.example.com

# חשוב! URL ציבורי ל-OAuth callbacks
# Caddy מנתב /oauth/* ל-connector
CONNECTOR_ORIGIN=https://agent.example.com

# host נפרד לקונסולת Open Connector (ברירת מחדל: console.$DOMAIN)
CONSOLE_DOMAIN=console.agent.example.com
# אופציונלי — דורס את כתובת הקונסול (ברירת מחדל: https://$CONSOLE_DOMAIN)
# CONSOLE_URL=https://console.agent.example.com
```

> **הערה:** טוקן Open Connector נוצר אחרי ההפעלה הראשונה בממשק.

> **טיפ — פורט 443 תפוס בשרת?** (למשל tailscaled שמאזין על 443): צור
> `docker-compose.override.yml` שקושר את Caddy רק ל-IP הספציפי:
>
> ```yaml
> services:
>   caddy:
>     ports: !override
>       - "10.0.0.5:80:80"
>       - "10.0.0.5:443:443"
> ```

## שלב 4: הפעלה ראשונה

```bash
# הרם את המערכת
docker compose up -d

# צפה בלוגים
docker compose logs -f
```

פתח בדפדפן: `https://agent.example.com/`

הזן את ה-PAIR_TOKEN בדף ההתחברות (טוקן גישה).

## שלב 5: אשף ההגדרה (WebUI)

הממשק מנחה את הלקוח דרך:

### 5.1 חיבור WhatsApp

1. מופיע קוד QR בממשק
2. הלקוח סורק עם WhatsApp (הגדרות → מכשירים מקושרים → קשר מכשיר)
3. המתנה לאישור חיבור

### 5.2 התחברות לספק AI

יש שתי אפשרויות; **תמיד העדיפו את הראשונה:**

**⭐ Claude — מנוי Pro/Max (מומלץ).** מפעיל את ה-login של Claude Code עצמו:
1. לחיצה על **התחבר** → נפתח חלון אישור ב-claude.ai (הלקוח מתחבר עם החשבון
   שיש לו מנוי!)
2. אחרי האישור claude.ai מציג **קוד להעתקה** — מעתיקים ומדביקים בתיבת
   "הדבק כאן" באשף
3. השימוש מתחייב ממכסת המנוי של הלקוח

**ChatGPT.** Device code flow — אחרי האישור הדפדפן ינסה לפתוח `localhost:1455`
וייכשל — מעתיקים את **הכתובת המלאה** משורת הכתובת ומדביקים באותה תיבה.
משתמש במנוי ChatGPT.
(המודל נקבע ל-`gpt-5.3-codex` — מודלי spark לא זמינים לחשבונות ChatGPT.)

בוואטסאפ, `/status` מציג את המנוע הפעיל ו-`/model claude-code/<שם>` מחליף
מודל בתוך Claude Code.

### 5.3 הגדרת זהות

הלקוח ממלא:
- שם
- שם העסק
- אזור זמן

המערכת כותבת את הנתונים ל-SOUL.md ו-AGENTS.md.

לאחר מילוי הזהות, האשף מסתיים והסוכן מוכן לשימוש.

## שלב 6: חיבור שירותים

### הגדרת OAuth App (מפעיל בלבד)

**זה שלב למפעיל — לא ללקוח!**

1. צור OAuth App ב-Google Cloud Console:
   - APIs & Services → Credentials → Create OAuth Client ID
   - Application type: Web application
   - Authorized redirect URI: `https://agent.example.com/oauth/callback`

2. הגדר את מסך ההסכמה (OAuth consent screen / Audience):
   - User type: **External** (לא Internal! Internal חוסם חשבונות Gmail
     רגילים עם שגיאת `org_internal`)
   - השאר במצב Testing והוסף את המייל של הלקוח כ-**Test user**
   - שים לב: במצב Testing ה-refresh tokens פגים אחרי 7 ימים — ללקוח
     קבוע לחץ **Publish app** (עם סקופים של Gmail יוצג מסך "unverified",
     ממשיכים דרך Advanced → Continue)

3. ב-Open Connector console (`https://console.agent.example.com`):
   - Providers → Google → Configure OAuth App
   - הזן Client ID ו-Client Secret
   - **אל תלחץ Connect!** הלקוח יחבר מ-Settings.

### חיבור Gmail ו-Calendar (לקוח)

הלקוח מחבר את Gmail ו-Google Calendar מדף **Settings** בממשק הסוכן:
1. לחיצה על **התחבר** ליד Gmail או Google Calendar
2. נפתח חלון OAuth — הלקוח מאשר גישה בחשבון Google שלו
3. החיבור מופיע בכלים

### שירותים אחרים (אופציונלי)

לכלים נוספים מעבר ל-Gmail/Calendar, המפעיל יכול להשתמש בקונסולת Open Connector:
`https://console.your-domain.com` (מתחברים עם `CONNECTOR_ADMIN_TOKEN` שמוגדר ב-`.env`).

ראה תיעוד Open Connector: https://github.com/oomol-lab/open-connector

## שלב 7: בדיקה

שלח הודעה לעצמך ב-WhatsApp:
```
/help
```

אמור לקבל תגובה עם רשימת הפקודות.

## דף Settings

לאחר ה-onboarding, דף Settings מאפשר:

- **Identity** - שם, עסק, timezone (עריכה)
- **AI Login** - ChatGPT / Claude (reconnect אם פג)
- **Gmail / Calendar** - כפתורי **התחבר** לחיבור Gmail ו-Google Calendar (OAuth popup)
- **Open Connector** - סטטוס ושירותים מחוברים
- **WhatsApp** - סטטוס ו-re-pair אם נדרש

לכלים נוספים, קיים קישור (אופציונלי) לקונסולת Open Connector בכתובת `https://console.{DOMAIN}` (בעברית: "כלים נוספים").

### עמוד כלים

מציג רק שירותי Open Connector **מחוברים**:
- כרטיסי לוגו + פעולות קריאות
- מצב ריק מפנה ל-Settings לחיבור Gmail/Calendar, או לקונסולת OC לכלים נוספים

## Caddy Routing

Caddy מטפל ב-TLS וב-routing:

| דומיין | נתיב | אימות | יעד | הערות |
|--------|------|-------|-----|-------|
| `{$CONSOLE_DOMAIN}` | `/*` | login של OC (admin token) | `connector:3000` | קונסול Open Connector — כל ה-origin |
| `{$DOMAIN}` | `/oauth/*` | ציבורי | `connector:3000` | יעד ה-redirect של OAuth |
| `{$DOMAIN}` | `/*` | PAIR_TOKEN cookie | `agent:3001` | אשף / הגדרות / API |

**אבטחה:**
- ה-SPA של הקונסול משתמש בנתיבים אבסולוטיים וב-router בלי base path, ולכן חייב host משלו — אי אפשר להגיש אותו תחת `/connector/` (#72)
- על `{$DOMAIN}` רק ה-OAuth callback מגיע לconnector; `/v1/*`, `/mcp`, `/api/files/*`, `/api/runs*`, `/openapi.json` נשארים פנימיים
- תעבורת agent-to-connector משתמשת ברשת Docker הפנימית

**DNS:** שני A records לאותו שרת — `your-domain.com` ו-`console.your-domain.com` (`deploy.sh <domain> [console-domain]`).

**כתובת הקונסול:** `https://console.your-domain.com` — אופציונלי לכלים נוספים. מפעילים מגדירים `CONNECTOR_ADMIN_TOKEN` ב-`.env` כדי להתחבר. אפשר לשנות עם `CONSOLE_DOMAIN` / `CONSOLE_URL`.

ודא ש-`CONNECTOR_ORIGIN` מכיל את ה-URL הציבורי של ה-agent.

## טיפים לייצור

```yaml
# docker-compose.yml - הגבלת זיכרון
services:
  agent:
    mem_limit: 3g
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## פתרון בעיות

### QR לא נטען

```bash
docker compose logs agent | grep -i qr
docker compose restart agent
```

### WhatsApp מתנתק (שגיאה 515)

המערכת מתחברת מחדש אוטומטית עם ה-credentials הקיימים.
אם נכשל:

```bash
docker compose stop agent
rm -rf data/whatsapp-auth/
docker compose start agent
# סרוק QR מחדש
```

### OAuth פג תוקף

הלקוח רואה הודעה ב-Settings לחיבור מחדש.

### Open Connector לא מגיב

```bash
docker compose ps
docker compose logs connector
```

### תעודת HTTPS לא עובדת

```bash
dig agent.example.com
docker compose logs caddy
```

## גיבוי

```bash
docker compose stop
tar -czf backup-$(date +%Y%m%d).tar.gz data/
docker compose start
```

## עדכון

```bash
git pull
docker compose build
docker compose up -d
```

### גרסאות מוצמדות

הגרסאות של Claude Code ו-Open Connector מוצמדות כדי למנוע שבירה כשתלויות
משתנות:

- **Claude Code**: `CLAUDE_CODE_VERSION` ב-Dockerfile (כרגע `2.1.258`)
- **Open Connector**: SHA ב-docker-compose.yml (כרגע `6788fec...`)

שדרוג ידני בלבד — אחרי אימות תאימות.

## צ׳קליסט להפעלה

- [ ] שרת CX23 / 4GB RAM פועל עם Docker
- [ ] DNS: שני A records (`DOMAIN` ו-`CONSOLE_DOMAIN` / `console.<domain>`) מצביעים לשרת
- [ ] .env מוגדר (PAIR_TOKEN, CONNECTOR_ENCRYPTION_KEY, DOMAIN, CONNECTOR_ORIGIN, CONSOLE_DOMAIN)
- [ ] `docker compose up -d` הצליח
- [ ] HTTPS פועל (אין אזהרת תעודה)
- [ ] ממשק ניהול נגיש
- [ ] QR נטען וWhatsApp מחובר
- [ ] AI Provider מחובר (ChatGPT או Claude)
- [ ] זהות הוגדרה (שם, עסק, timezone)
- [ ] `/help` מחזיר תגובה
- [ ] (אופציונלי) Gmail/Calendar מחוברים מ-Settings

## תמיכה

- בעיות טכניות: פתח Issue ב-GitHub
- שאלות כלליות: פתח Discussion
- בעיות אבטחה: פנה ישירות במייל
