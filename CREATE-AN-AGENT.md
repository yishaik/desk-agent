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

הצבע את הדומיין שלך לכתובת ה-IP של השרת:

```
A    agent.example.com    → 1.2.3.4
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

# הדומיין שלך
DOMAIN=agent.example.com

# חשוב! URL ציבורי ל-OAuth callbacks
# Caddy מנתב /oauth/* ל-connector
CONNECTOR_ORIGIN=https://agent.example.com
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

פתח בדפדפן: `https://agent.example.com/?token=YOUR_PAIR_TOKEN`

## שלב 5: אשף ההגדרה (WebUI)

הממשק מנחה את הלקוח דרך:

### 5.1 חיבור WhatsApp

1. מופיע קוד QR בממשק
2. הלקוח סורק עם WhatsApp (הגדרות → מכשירים מקושרים → קשר מכשיר)
3. המתנה לאישור חיבור

### 5.2 התחברות לספק AI

יש שלוש אפשרויות; **תמיד העדיפו את הראשונה:**

**⭐ Claude — מנוי Pro/Max (מומלץ).** מפעיל את ה-login של Claude Code עצמו:
1. לחיצה על **התחבר** → נפתח חלון אישור ב-claude.ai (הלקוח מתחבר עם החשבון
   שיש לו מנוי!)
2. אחרי האישור claude.ai מציג **קוד להעתקה** — מעתיקים ומדביקים בתיבת
   "הדבק כאן" באשף
3. השימוש מתחייב ממכסת המנוי של הלקוח. זו הדרך היחידה שתואמת את תנאי
   Anthropic — מסלול ה-OAuth הישן (האפשרות השלישית) מחויב מ-**extra usage**
   פר-טוקן ואף מנוגד ל-ToS.

**ChatGPT.** אחרי האישור הדפדפן ינסה לפתוח `localhost:1455` וייכשל — מעתיקים
את **הכתובת המלאה** משורת הכתובת ומדביקים באותה תיבה. משתמש במנוי ChatGPT.
(המודל נקבע ל-`gpt-5.3-codex` — מודלי spark לא זמינים לחשבונות ChatGPT.)

**Claude · extra usage.** נשאר לתאימות בלבד — אל תשתמשו ללקוחות.

בוואטסאפ, `/status` מציג את המנוע הפעיל ו-`/model claude-code/<שם>` מחליף
מודל בתוך Claude Code.

### 5.3 הגדרת זהות

הלקוח ממלא:
- שם
- שם העסק
- אזור זמן

המערכת כותבת את הנתונים ל-SOUL.md ו-AGENTS.md.

### 5.4 בדיקת Open Connector

המערכת בודקת חיבור ל-Open Connector.

### 5.5 טוקן מנהל

- הטוקן מוצג **פעם אחת בלבד**
- הלקוח חייב לשמור אותו במקום בטוח
- לחיצה על "שמרתי" לסיום

## שלב 6: חיבור שירותים

### Gmail ו-Google Calendar

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

3. ב-Open Connector:
   - Providers → Google → Configure OAuth App
   - הזן Client ID ו-Client Secret
   - לחץ Connect ואשר גישה

### שירותים אחרים

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
- **Open Connector** - סטטוס ושירותים מחוברים
- **WhatsApp** - סטטוס ו-re-pair אם נדרש

### עמוד כלים

מציג רק שירותי Open Connector **מחוברים**:
- כרטיסי לוגו + פעולות קריאות
- מצב ריק מפנה לקונסולת OC

## Caddy Routing

Caddy מטפל ב-TLS וב-routing:

| דומיין | נתיב | אימות | יעד | הערות |
|--------|------|-------|-----|-------|
| `{$DOMAIN}` | `/oauth/*`, `/api/oauth/*` | ציבורי | `connector:3000` | OAuth flows |
| `{$DOMAIN}` | `/connector/*` | Cookie | `connector:3000` | קונסול SPA |
| `{$DOMAIN}` | `/assets/*`, `/api/connections*`, `/api/providers*`, `/api/actions/*` | Cookie | `connector:3000` | APIs לקונסול |
| `{$DOMAIN}` | `/*` | Cookie | `agent:3001` | Agent UI/API |

**אבטחה:**
- הקונסול וה-APIs שלו מוגנים ב-PAIR_TOKEN cookie (כמו Settings)
- `/mcp`, `/v1/*`, `/api/files/*`, `/api/runs*`, `/openapi.json` **לא** חשופים בכלל
- תעבורת agent-to-connector משתמשת ברשת Docker הפנימית
- OAuth routes ציבוריים (redirect flow)

**כתובת הקונסול:** `https://your-domain.com/connector/` (דורש התחברות)

ודא ש-`CONNECTOR_ORIGIN` מכיל את ה-URL הציבורי.

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

## צ׳קליסט להפעלה

- [ ] שרת CX23 / 4GB RAM פועל עם Docker
- [ ] DNS מצביע לשרת
- [ ] .env מוגדר (PAIR_TOKEN, CONNECTOR_ENCRYPTION_KEY, DOMAIN, CONNECTOR_ORIGIN)
- [ ] `docker compose up -d` הצליח
- [ ] HTTPS פועל (אין אזהרת תעודה)
- [ ] ממשק ניהול נגיש
- [ ] QR נטען וWhatsApp מחובר
- [ ] AI Provider מחובר (ChatGPT או Claude)
- [ ] זהות הוגדרה (שם, עסק, timezone)
- [ ] טוקן מנהל נשמר
- [ ] לפחות שירות אחד מחובר ב-OC
- [ ] `/help` מחזיר תגובה

## תמיכה

- בעיות טכניות: פתח Issue ב-GitHub
- שאלות כלליות: פתח Discussion
- בעיות אבטחה: פנה ישירות במייל
