# Create an Agent - מדריך למפתחים

מדריך להקמת סוכן חדש ללקוח או לעצמך.

## דרישות מקדימות

- שרת עם Docker (VPS, מחשב מקומי, וכו׳)
- דומיין עם גישת DNS (לייצור)
- מפתח API של Anthropic (או ספק אחר)
- WhatsApp על הטלפון

## שלב 1: הכנת השרת

### אפשרות א׳ - Hetzner (מומלץ)

1. צור שרת CX22 (2 vCPU, 4GB RAM) - כ-$5/חודש
2. בחר Ubuntu 22.04
3. הוסף מפתח SSH

```bash
# התחבר לשרת
ssh root@your-server-ip

# התקן Docker
curl -fsSL https://get.docker.com | sh
```

### אפשרות ב׳ - Oracle Cloud Free Tier

1. צור חשבון Oracle Cloud
2. צור VM.Standard.A1.Flex (ARM, חינמי לצמיתות)
3. התקן Docker כמו למעלה

### אפשרות ג׳ - מקומי

```bash
# macOS
brew install docker

# Ubuntu
curl -fsSL https://get.docker.com | sh
```

## שלב 2: הגדרת DNS

הצבע את הדומיין שלך לכתובת ה-IP של השרת:

```
A    agent.example.com    → 1.2.3.4
```

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

# מפתח API של Anthropic
MODEL_API_KEY=sk-ant-...

# טוקן Open Connector (ייצור אחרי ההפעלה הראשונה)
OPEN_CONNECTOR_TOKEN=

# מפתח הצפנה לסיסמאות
CONNECTOR_ENCRYPTION_KEY=$(openssl rand -hex 32)

# הדומיין שלך
DOMAIN=agent.example.com
CONNECTOR_ORIGIN=https://agent.example.com
```

## שלב 4: הפעלה ראשונה

```bash
# הרם את המערכת
docker compose up -d

# צפה בלוגים
docker compose logs -f
```

פתח בדפדפן: `https://agent.example.com/?token=YOUR_PAIR_TOKEN`

## שלב 5: חיבור WhatsApp

1. פתח את ממשק הניהול
2. סרוק את ה-QR עם WhatsApp (הגדרות → מכשירים מקושרים → קשר מכשיר)
3. המתן לחיבור

## שלב 6: יצירת טוקן Open Connector

1. פתח Open Connector: `https://agent.example.com:3000` (או דרך Docker network)
2. לך ל-Access → Create Runtime Token
3. העתק את הטוקן
4. עדכן ב-.env: `OPEN_CONNECTOR_TOKEN=oct_...`
5. הפעל מחדש: `docker compose restart agent`

## שלב 7: חיבור שירותים

### Gmail ו-Google Calendar

1. צור OAuth App ב-Google Cloud Console:
   - APIs & Services → Credentials → Create OAuth Client ID
   - Application type: Web application
   - Authorized redirect URI: `https://agent.example.com:3000/oauth/callback`

2. ב-Open Connector:
   - Providers → Google → Configure OAuth App
   - הזן Client ID ו-Client Secret
   - לחץ Connect ואשר גישה

### שירותים אחרים

ראה תיעוד Open Connector: https://github.com/oomol-lab/open-connector

## שלב 8: בדיקה

שלח הודעה לעצמך ב-WhatsApp:
```
/help
```

אמור לקבל תגובה עם רשימת הפקודות.

## התאמה אישית

### שינוי שם הבוט

ב-.env או בממשק הניהול:
```
BOT_NAME=My Agent
```

### הוספת Skill Packs

```bash
# העתק skill pack
mkdir -p .pi/skills
cp skills-pack/inbox-calendar.json .pi/skills/

# הפעל מחדש
docker compose restart agent
```

### שינוי מודל

ב-.env:
```bash
MODEL_API_URL=https://api.openai.com/v1/chat/completions
```

או בממשק הניהול.

## פתרון בעיות

### QR לא נטען

```bash
# בדוק לוגים
docker compose logs agent | grep -i qr

# הפעל מחדש
docker compose restart agent
```

### WhatsApp מתנתק

```bash
# מחק סשן ישן
docker compose stop agent
rm -rf data/whatsapp-auth/
docker compose start agent
# סרוק QR מחדש
```

### Open Connector לא מגיב

```bash
# בדוק סטטוס
docker compose ps

# בדוק לוגים
docker compose logs connector
```

### תעודת HTTPS לא עובדת

```bash
# בדוק DNS
dig agent.example.com

# בדוק Caddy
docker compose logs caddy
```

## גיבוי

```bash
# גיבוי נתונים
docker compose stop
tar -czf backup-$(date +%Y%m%d).tar.gz data/
docker compose start

# שחזור
tar -xzf backup-YYYYMMDD.tar.gz
```

## עדכון

```bash
# משוך גרסה חדשה
git pull

# בנה מחדש
docker compose build
docker compose up -d
```

## צ׳קליסט להפעלה

- [ ] שרת פועל עם Docker
- [ ] DNS מצביע לשרת
- [ ] .env מוגדר נכון
- [ ] `docker compose up -d` הצליח
- [ ] HTTPS פועל (אין אזהרת תעודה)
- [ ] ממשק ניהול נגיש
- [ ] QR נטען
- [ ] WhatsApp מחובר
- [ ] Open Connector טוקן נוצר
- [ ] לפחות שירות אחד מחובר
- [ ] `/help` מחזיר תגובה

## תמיכה

- בעיות טכניות: פתח Issue ב-GitHub
- שאלות כלליות: פתח Discussion
- בעיות אבטחה: פנה ישירות במייל
