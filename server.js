const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// الإصدار الحالي للتطبيق والتحديث المباشر
const APP_VERSION = '2.2.0';
const APP_RELEASE_DATE = '2026-10-22';

// -------------------------------------------------------------
// نظام الحماية والأمان المتقدم من الاختراقات (Advanced Security & Auth)
// -------------------------------------------------------------
const activeSessions = new Map(); // token -> { createdAt, expiresAt, ip }
const failedLoginAttempts = new Map(); // ip -> { count, lockedUntil }
const ipRateLimiter = new Map(); // ip -> [timestamps]

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req, maxPerMin = 120) {
  const ip = getClientIp(req);
  const now = Date.now();
  const windowStart = now - 60000;
  let timestamps = ipRateLimiter.get(ip) || [];
  timestamps = timestamps.filter(t => t > windowStart);
  if (timestamps.length >= maxPerMin) {
    return false;
  }
  timestamps.push(now);
  ipRateLimiter.set(ip, timestamps);
  return true;
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isIpLocked(ip) {
  if (!failedLoginAttempts.has(ip)) return false;
  const entry = failedLoginAttempts.get(ip);
  if (Date.now() > entry.lockedUntil) {
    failedLoginAttempts.delete(ip);
    return false;
  }
  return true;
}

function recordFailedLogin(ip) {
  const entry = failedLoginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 15 * 60 * 1000; // قفل 15 دقيقة
    console.warn(`🚨 [حماية أمنية] تم حظر عنوان IP (${ip}) مؤقتاً لمدة 15 دقيقة بعد 5 محاولات خاطئة.`);
  }
  failedLoginAttempts.set(ip, entry);
}

function clearFailedLogins(ip) {
  failedLoginAttempts.delete(ip);
}

function verifyAuth(req) {
  const data = loadData();
  const security = data.security || {};
  
  // إذا لم يتم تهيئة رمز الحماية بعد، نسمح بالوصول الكامل دون إغلاق التطبيق
  if (!security.pinHash) {
    return { authenticated: true, setupRequired: true };
  }

  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers['cookie']) {
    const match = req.headers['cookie'].match(/mp_auth=([a-f0-9]+)/);
    if (match) token = match[1];
  }

  if (token && activeSessions.has(token)) {
    const session = activeSessions.get(token);
    if (Date.now() < session.expiresAt) {
      return { authenticated: true, setupRequired: false };
    } else {
      activeSessions.delete(token);
    }
  }

  return { authenticated: false, setupRequired: false };
}

// التحقق من توقيع Meta Webhook المشفر (HMAC-SHA256) لمنع تزوير الطلبات
function verifyMetaWebhookSignature(req, appSecret) {
  if (!appSecret) return true; // إذا لم يُدخل المستخدم مفتاح التطبيق نمرر الطلب
  const signatureHeader = req.headers['x-hub-signature-256'];
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    console.warn(`🚨 [تأمين Webhook] تم رفض طلب غير موقع من Meta!`);
    return false;
  }
  try {
    const expectedHash = signatureHeader.substring(7);
    const calculatedHash = crypto.createHmac('sha256', appSecret).update(req.rawBody || '').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(calculatedHash, 'hex'));
  } catch (err) {
    console.error('خطأ أثناء التحقق من توقيع Webhook:', err);
    return false;
  }
}

// مساعد لقراءة وتحديث ملف البيانات
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { 
        settings: { 
          verifyToken: 'my_secret_fb_verify_token_2026',
          antiBan: {
            enabled: true,
            minDelaySeconds: 2,
            maxDelaySeconds: 5,
            enableUserCooldown: true,
            userCooldownMinutes: 10,
            enableDeduplication: true,
            autoBackoffOnLimit: true
          }
        }, 
        security: {},
        rules: [], 
        logs: [] 
      };
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.security) parsed.security = {};
    return parsed;
  } catch (err) {
    console.error('خطأ في قراءة ملف البيانات:', err);
    return { settings: {}, security: {}, rules: [], logs: [] };
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ في حفظ ملف البيانات:', err);
  }
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      req.rawBody = body;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({ raw: body });
      }
    });
    req.on('error', reject);
  });
}

// -------------------------------------------------------------
// نظام درع الحماية ومكافحة الحظر المتطور (Advanced Anti-Ban & Safe Queue Engine)
// -------------------------------------------------------------

// محلل صيغ Spintax لتوليد ردود لا نهائية: {أهلاً|مرحباً|يا هلا}
function parseSpintax(text) {
  if (!text) return '';
  const spintaxRegex = /\{([^{}]+)\}/g;
  let result = text;
  let passes = 0;
  while (spintaxRegex.test(result) && passes < 10) {
    result = result.replace(spintaxRegex, (match, choices) => {
      // تجنب استبدال وسم العميل {user}
      if (choices.trim().toLowerCase() === 'user') return '{user}';
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)].trim();
    });
    passes++;
  }
  return result;
}

// قائمة رموز وتنويعات تلقائية لمنع تطابق أي تعليقين متتاليين بنسبة 100%
const DIVERSITY_EMOJIS = ['✨', '📩', '🌹', '🌟', '💼', '👌', '⚡', '🌷', '✅', '💫'];

function ensureTextDiversity(text, lastText) {
  let modified = text;
  // إذا كان النص يطابق النص السابق تماماً، نضمن التنوع بإضافة رمز عشوائي أو تنويع طفيف
  if (modified === lastText || Math.random() > 0.3) {
    const randomEmoji = DIVERSITY_EMOJIS[Math.floor(Math.random() * DIVERSITY_EMOJIS.length)];
    if (!modified.includes(randomEmoji)) {
      modified = `${modified} ${randomEmoji}`;
    } else {
      modified = `${modified} .`;
    }
  }
  return modified.trim();
}

// متتبع سرعة الردود الساعي لحماية معدلات API
class HourlyVelocityTracker {
  constructor() {
    this.replyTimestamps = [];
  }
  canReply(maxPerHour = 150) {
    const oneHourAgo = Date.now() - 3600000;
    this.replyTimestamps = this.replyTimestamps.filter(t => t > oneHourAgo);
    return this.replyTimestamps.length < maxPerHour;
  }
  recordReply() {
    this.replyTimestamps.push(Date.now());
  }
  getHourlyCount() {
    const oneHourAgo = Date.now() - 3600000;
    this.replyTimestamps = this.replyTimestamps.filter(t => t > oneHourAgo);
    return this.replyTimestamps.length;
  }
}

// فحص الكلمات السلبية أو الشكاوى (لتجنب الرد الآلي على العملاء الغاضبين)
function hasNegativeKeywords(text, negativeKeywords = []) {
  if (!text || !negativeKeywords.length) return false;
  const lower = text.toLowerCase();
  return negativeKeywords.some(badWord => lower.includes(badWord.toLowerCase().trim()));
}

// فحص سياسة ميتا (7 أيام كحد أقصى للرد الخاص على التعليق)
function isCommentWithinPolicyWindow(createdTime) {
  if (!createdTime) return true;
  const createdMs = typeof createdTime === 'number' 
    ? (createdTime > 1e11 ? createdTime : createdTime * 1000) 
    : new Date(createdTime).getTime();
  if (isNaN(createdMs)) return true;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return (Date.now() - createdMs) < sevenDaysMs;
}

class AntiBanQueueEngine {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.processedComments = new Set(); // منع الرد المكرر على نفس التعليق
    this.userLastReplyTime = new Map();  // منع إغراق نفس الشخص بالرسائل
    this.lastPublicReplyText = '';
    this.isBackoffActive = false;
    this.backoffUntil = null;
    this.velocityTracker = new HourlyVelocityTracker();
  }

  // إضافة تعليق للطابور الآمن
  enqueue(task) {
    const data = loadData();
    const antiBan = (data.settings && data.settings.antiBan) || { enabled: true };

    // 0. فحص زر الطوارئ الفوري (Emergency Stop)
    if (antiBan.emergencyStop) {
      console.log(`🛑 [زر الطوارئ] تم تفعيل الإيقاف المؤقت للردود من قبل الإدارة. تم تجاهل التعليق (${task.commentId}).`);
      data.logs.unshift({
        id: 'log_' + Date.now(),
        timestamp: new Date().toISOString(),
        platform: task.platform,
        postId: task.postId || 'all',
        author: task.authorName,
        comment: task.commentText,
        matchedRule: task.ruleName,
        publicReply: 'تم الإيقاف مؤقتاً (زر الطوارئ نشط)',
        privateReply: '-',
        status: 'warning',
        securityNote: 'زر الطوارئ اللحظي مفعّل'
      });
      if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
      saveData(data);
      return;
    }

    // 1. فحص منع التكرار للتعليق (Deduplication)
    if (antiBan.enableDeduplication && task.commentId && this.processedComments.has(task.commentId)) {
      console.log(`[درع الأمان] تم تجاهل التعليق (${task.commentId}) لأنه عولج مسبقاً.`);
      return;
    }

    if (task.commentId) {
      this.processedComments.add(task.commentId);
      if (this.processedComments.size > 5000) {
        const first = this.processedComments.values().next().value;
        this.processedComments.delete(first);
      }
    }

    this.queue.push(task);
    this.processNext();
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    // فحص التهدئة التلقائية (Auto-Backoff) عند ضغط فيسبوك
    if (this.isBackoffActive && this.backoffUntil) {
      if (Date.now() < this.backoffUntil) {
        setTimeout(() => this.processNext(), 5000);
        return;
      }
      this.isBackoffActive = false;
      this.backoffUntil = null;
      console.log('✅ انتهت فترة التهدئة التلقائية لفيسبوك، تم استئناف الردود بأمان.');
    }

    const data = loadData();
    const antiBan = (data.settings && data.settings.antiBan) || { 
      enabled: true, 
      minDelaySeconds: 2, 
      maxDelaySeconds: 5,
      enableUserCooldown: true,
      userCooldownMinutes: 10,
      maxRepliesPerHour: 150
    };

    // فحص محدد السرعة الساعي (Hourly Velocity Limiter)
    if (antiBan.enabled && !this.velocityTracker.canReply(antiBan.maxRepliesPerHour || 150)) {
      console.warn(`⏳ [حد السرعة الساعي] تم الوصول للحد الأقصى (${antiBan.maxRepliesPerHour}/ساعة) لتأمين الصفحة. تأخير الردود دقيقة واحدة...`);
      setTimeout(() => this.processNext(), 60000);
      return;
    }

    this.isProcessing = true;
    const task = this.queue.shift();

    try {
      // 2. فحص فترة التهدئة للمستخدم نفسه (User Cooldown)
      const userKey = `${task.platform}_${task.authorId || task.authorName}`;
      let skipPrivateReply = false;

      if (antiBan.enableUserCooldown && task.authorId) {
        const lastTime = this.userLastReplyTime.get(userKey);
        const cooldownMs = (antiBan.userCooldownMinutes || 10) * 60 * 1000;
        if (lastTime && (Date.now() - lastTime < cooldownMs)) {
          console.log(`[درع الأمان] العميل (${task.authorName}) أرسل تعليقاً مكرراً خلال فترة التهدئة، سيتم الرد عام فقط وتجنب إزعاجه في الخاص.`);
          skipPrivateReply = true;
        } else {
          this.userLastReplyTime.set(userKey, Date.now());
        }
      }

      // 3. فحص سياسة ميتا للـ 7 أيام (Meta Messaging Window Policy)
      if (antiBan.enforce7DayPolicy && task.createdTime && !isCommentWithinPolicyWindow(task.createdTime)) {
        console.log(`[درع الأمان] التعليق أقدم من 7 أيام. تم إلغاء الرد الخاص لتجنب مخالفة سياسة Meta للمراسلات.`);
        skipPrivateReply = true;
      }

      // 4. تأخير عشوائي بشري ذكي (Human Simulation Delay)
      let delayMs = 0;
      if (antiBan.enabled && !task.isImmediate) {
        const min = (antiBan.minDelaySeconds || 2) * 1000;
        const max = (antiBan.maxDelaySeconds || 5) * 1000;
        delayMs = Math.floor(Math.random() * (max - min + 1)) + min;
        console.log(`⏳ [درع الأمان] تأخير هادئ وآمن لمدة ${(delayMs / 1000).toFixed(1)} ثانية لمحاكاة التفاعل البشري...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      // 5. تطبيق التنوع الدلالي العشوائي على النص العام
      const finalPublicReply = ensureTextDiversity(task.publicReply, this.lastPublicReplyText);
      this.lastPublicReplyText = finalPublicReply;

      // 6. تنفيذ الرد الفعلي
      let sendResult = { success: true, simulated: true };
      if (task.platform === 'instagram') {
        sendResult = await sendInstagramGraphReplies(
          task.commentId, 
          finalPublicReply, 
          skipPrivateReply ? null : task.privateReply, 
          data.settings
        );
      } else {
        sendResult = await sendFacebookGraphReplies(
          task.commentId, 
          finalPublicReply, 
          skipPrivateReply ? null : task.privateReply, 
          data.settings
        );
      }

      // تسجيل العملية في محدد السرعة الساعي
      this.velocityTracker.recordReply();

      // فحص أخطاء Rate Limit (كود 429 أو 613 أو 32)
      if (!sendResult.success && (sendResult.statusCode === 429 || sendResult.errorCode === 613 || sendResult.errorCode === 32)) {
        console.warn('⚠️ [تحذير Meta] تم بلوغ حد الطلبات المؤقت لفيسبوك. تفعيل التهدئة التلقائية لمدة 60 ثانية لحماية الحساب!');
        this.isBackoffActive = true;
        this.backoffUntil = Date.now() + 60000;
      }

      // 7. تسجيل العملية في السجل
      const logEntry = {
        id: 'log_' + Date.now(),
        timestamp: new Date().toISOString(),
        platform: task.platform,
        postId: task.postId || 'all',
        author: task.authorName,
        comment: task.commentText,
        matchedRule: task.ruleName + (task.isPostSpecific ? ' 🎯 [مخصص]' : ' 🌐 [عام]'),
        publicReply: finalPublicReply,
        privateReply: skipPrivateReply ? 'تم تجاوز الخاص (حماية من الحظر/التكرار)' : task.privateReply,
        delayUsed: `${(delayMs / 1000).toFixed(1)} ثانية`,
        status: sendResult.success ? 'success' : 'warning',
        securityNote: 'محمي بدرع مكافحة الحظر'
      };

      data.logs.unshift(logEntry);
      if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
      saveData(data);

    } catch (err) {
      console.error('خطأ أثناء معالجة طابور الأمان:', err);
    } finally {
      this.isProcessing = false;
      this.processNext();
    }
  }
}

const antiBanQueue = new AntiBanQueueEngine();

// مطابقة التعليق مع القواعد المخزنة
function matchCommentToRules(commentText, rules, authorName = 'العميل', platform = 'both', postId = null, negativeKeywords = []) {
  if (!commentText) return null;

  // فحص الكلمات السلبية أو الشكاوى
  if (hasNegativeKeywords(commentText, negativeKeywords)) {
    return { isNegativeWarning: true };
  }

  const cleanText = commentText.toLowerCase().trim();
  const cleanPostId = postId ? String(postId).trim().toLowerCase() : null;

  // 1. أولوية المنشور المحدد (Post-Specific)
  if (cleanPostId) {
    for (const rule of rules) {
      if (!rule.isActive) continue;
      if (rule.postScope !== 'specific') continue;

      const rulePostId = rule.postId ? String(rule.postId).trim().toLowerCase() : '';
      if (!rulePostId || (rulePostId !== cleanPostId && !cleanPostId.includes(rulePostId) && !rulePostId.includes(cleanPostId))) {
        continue;
      }

      const rulePlatform = rule.platform || 'both';
      if (rulePlatform !== 'both' && platform !== 'both' && rulePlatform !== platform) {
        continue;
      }

      const matchedKeyword = rule.keywords.find(kw => cleanText.includes(kw.toLowerCase().trim()));
      if (matchedKeyword) {
        return buildMatchResult(rule, matchedKeyword, authorName, platform, true);
      }
    }
  }

  // 2. القواعد العامة (All Posts)
  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.postScope === 'specific') continue;

    const rulePlatform = rule.platform || 'both';
    if (rulePlatform !== 'both' && platform !== 'both' && rulePlatform !== platform) {
      continue;
    }

    const matchedKeyword = rule.keywords.find(kw => cleanText.includes(kw.toLowerCase().trim()));
    if (matchedKeyword) {
      return buildMatchResult(rule, matchedKeyword, authorName, platform, false);
    }
  }

  return null;
}

function buildMatchResult(rule, matchedKeyword, authorName, platform, isPostSpecific) {
  const defaultReply = platform === 'instagram' 
    ? '{أهلاً بك|مرحباً}! تم إرسال التفاصيل في الـ DM فوراً 📩' 
    : '{أهلاً بك|مرحباً}! تم إرسال التفاصيل في الرسائل الخاصة 📩';

  const replies = rule.publicReplies && rule.publicReplies.length > 0 
    ? rule.publicReplies 
    : [defaultReply];

  // اختيار رد عشوائي
  let chosenRaw = replies[Math.floor(Math.random() * replies.length)];
  if (replies.length > 1 && chosenRaw === antiBanQueue.lastPublicReplyText) {
    const otherReplies = replies.filter(r => r !== antiBanQueue.lastPublicReplyText);
    chosenRaw = otherReplies[Math.floor(Math.random() * otherReplies.length)];
  }

  // تطبيق محرك الـ Spintax لتوليد نصوص متجددة
  let parsedPublic = parseSpintax(chosenRaw).replace(/{user}/g, authorName);
  let parsedPrivate = parseSpintax(rule.privateReply || 'أهلاً بك! تم استلام استفسارك وسنرد عليك فوراً.')
    .replace(/{user}/g, authorName);

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    platform: rule.platform || 'both',
    postScope: rule.postScope || 'all',
    postId: rule.postId || '',
    isPostSpecific,
    keyword: matchedKeyword,
    publicReply: parsedPublic,
    privateReply: parsedPrivate
  };
}

// إرسال رد فعلي إلى فيسبوك مع التقاط أخطاء الـ Rate Limits
async function sendFacebookGraphReplies(commentId, publicReplyText, privateReplyText, settings) {
  if (!settings.enableLiveGraphApi || !settings.pageAccessToken) {
    return { success: true, simulated: true };
  }

  try {
    if (publicReplyText) {
      const publicUrl = `https://graph.facebook.com/v20.0/${commentId}/comments?access_token=${encodeURIComponent(settings.pageAccessToken)}`;
      const pubRes = await fetch(publicUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: publicReplyText })
      });
      if (!pubRes.ok) {
        const errJson = await pubRes.json().catch(() => ({}));
        return { success: false, statusCode: pubRes.status, errorCode: errJson?.error?.code, error: errJson };
      }
    }

    if (privateReplyText) {
      const privateUrl = `https://graph.facebook.com/v20.0/${settings.pageId || 'me'}/messages?access_token=${encodeURIComponent(settings.pageAccessToken)}`;
      const privRes = await fetch(privateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { comment_id: commentId },
          message: { text: privateReplyText }
        })
      });
      if (!privRes.ok) {
        const errJson = await privRes.json().catch(() => ({}));
        return { success: false, statusCode: privRes.status, errorCode: errJson?.error?.code, error: errJson };
      }
    }

    return { success: true, simulated: false };
  } catch (err) {
    console.error('خطأ أثناء إرسال الرد عبر فيسبوك API:', err);
    return { success: false, error: err.message };
  }
}

// إرسال رد فعلي إلى إنستغرام مع التقاط أخطاء الـ Rate Limits
async function sendInstagramGraphReplies(commentId, publicReplyText, privateReplyText, settings) {
  if (!settings.enableLiveGraphApi || !settings.pageAccessToken) {
    return { success: true, simulated: true };
  }

  try {
    if (publicReplyText) {
      const igRepliesUrl = `https://graph.facebook.com/v20.0/${commentId}/replies?access_token=${encodeURIComponent(settings.pageAccessToken)}`;
      const pubRes = await fetch(igRepliesUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: publicReplyText })
      });
      if (!pubRes.ok) {
        const errJson = await pubRes.json().catch(() => ({}));
        return { success: false, statusCode: pubRes.status, errorCode: errJson?.error?.code, error: errJson };
      }
    }

    if (privateReplyText) {
      const igAccount = settings.instagramAccountId || settings.pageId || 'me';
      const igMessagesUrl = `https://graph.facebook.com/v20.0/${igAccount}/messages?access_token=${encodeURIComponent(settings.pageAccessToken)}`;
      const privRes = await fetch(igMessagesUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { comment_id: commentId },
          message: { text: privateReplyText }
        })
      });
      if (!privRes.ok) {
        const errJson = await privRes.json().catch(() => ({}));
        return { success: false, statusCode: privRes.status, errorCode: errJson?.error?.code, error: errJson };
      }
    }

    return { success: true, simulated: false };
  } catch (err) {
    console.error('خطأ أثناء إرسال الرد عبر إنستغرام API:', err);
    return { success: false, error: err.message };
  }
}

// خادم HTTP الموحد
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const pathname = reqUrl.pathname;
  const method = req.method;

  // هيدرات الأمان والحماية المتقدمة (Security Headers)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // فحص معدل الطلبات لمنع هجمات حجب الخدمة (DDoS / Rate Limiter)
  if (!checkRateLimit(req)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'RATE_LIMIT_EXCEEDED', message: 'تم تجاوز الحد المسموح به من الطلبات مؤقتاً.' }));
    return;
  }

  // 1. التحقق من Webhook
  if (method === 'GET' && pathname === '/webhook') {
    const data = loadData();
    const mode = reqUrl.searchParams.get('hub.mode');
    const token = reqUrl.searchParams.get('hub.verify_token');
    const challenge = reqUrl.searchParams.get('hub.challenge');

    const expectedToken = (data.settings && data.settings.verifyToken) || 'my_secret_fb_verify_token_2026';

    if (mode === 'subscribe' && token === expectedToken) {
      console.log('✅ تم توثيق رابط الـ Webhook مع Meta بنجاح!');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
      return;
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Verification token mismatch');
      return;
    }
  }

  // 2. استقبال أحداث فيسبوك وإنستغرام (مع التحقق الأمني من توقيع Meta)
  if (method === 'POST' && pathname === '/webhook') {
    try {
      const body = await parseRequestBody(req);
      const data = loadData();
      const appSecret = data.security && data.security.appSecret;

      // تحقق أمني مشفر: التأكد من أن الطلب صادر فعلياً من سيرفرات Meta
      if (appSecret && !verifyMetaWebhookSignature(req, appSecret)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'INVALID_SIGNATURE', message: 'فشل التحقق من توقيع Meta الأمني (طلب غير موثق)' }));
        return;
      }

      const antiBan = (data.settings && data.settings.antiBan) || {};
      const negativeList = (antiBan.enableNegativeFilter) ? (antiBan.negativeKeywords || []) : [];

      // رد فوري على فيسبوك لتفادي مشكلة الـ Webhook Timeout
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'EVENT_RECEIVED' }));

      // أ) فيسبوك
      if (body.object === 'page' && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          if (Array.isArray(entry.changes)) {
            for (const change of entry.changes) {
              if (change.field === 'feed' && change.value && change.value.item === 'comment' && change.value.verb === 'add') {
                const comment = change.value;
                const authorName = comment.sender_name || 'زائر فيسبوك';
                const authorId = comment.sender_id || (comment.from && comment.from.id);
                const commentText = comment.message || '';
                const commentId = comment.comment_id;
                const postId = comment.post_id;
                const createdTime = comment.created_time || Date.now();

                // حماية رقم 1: منع الرد على تعليقات الصفحة أو الأدمين (Self-Loop Prevention)
                const pageId = data.settings && data.settings.pageId;
                const igId = data.settings && data.settings.instagramAccountId;
                if (authorId && (authorId === pageId || authorId === igId)) {
                  console.log(`[درع الأمان] تم تجاهل تعليق الصفحة نفسها لمنع الحلقات التكرارية.`);
                  continue;
                }

                const matchResult = matchCommentToRules(commentText, data.rules, authorName, 'facebook', postId, negativeList);

                // حماية رقم 2: فحص الكلمات السلبية / الغاضبة
                if (matchResult && matchResult.isNegativeWarning) {
                  console.warn(`⚠️ [درع الأمان] تم اكتشاف تعليق سلبي/شكوى من (${authorName}): "${commentText}". تم إيقاف الرد التلقائي لحماية تقييم الصفحة.`);
                  data.logs.unshift({
                    id: 'log_' + Date.now(),
                    timestamp: new Date().toISOString(),
                    platform: 'facebook',
                    postId: postId || 'all',
                    author: authorName,
                    comment: commentText,
                    matchedRule: '⚠️ تعليق سلبي/شكوى مستبعدة',
                    publicReply: 'تم الإلغاء تلقائياً لتجنب الاستفزاز',
                    privateReply: 'تنبيه: تم تحويل العميل للمراجعة اليدوية',
                    status: 'warning',
                    securityNote: 'فلتر حماية السمعة ومنع بلاغات السبام'
                  });
                  if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
                  saveData(data);
                  continue;
                }

                if (matchResult) {
                  antiBanQueue.enqueue({
                    platform: 'facebook',
                    commentId,
                    postId,
                    authorName,
                    authorId,
                    createdTime,
                    commentText,
                    ruleName: matchResult.ruleName,
                    isPostSpecific: matchResult.isPostSpecific,
                    publicReply: matchResult.publicReply,
                    privateReply: matchResult.privateReply
                  });
                } else {
                  data.logs.unshift({
                    id: 'log_' + Date.now(),
                    timestamp: new Date().toISOString(),
                    platform: 'facebook',
                    postId: postId || 'unknown',
                    author: authorName,
                    comment: commentText,
                    matchedRule: 'لا توجد قاعدة مطابقة',
                    publicReply: 'تم التجاهل',
                    privateReply: '-',
                    status: 'skipped'
                  });
                  if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
                  saveData(data);
                }
              }
            }
          }
        }
      }

      // ب) إنستغرام
      if (body.object === 'instagram' && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          if (Array.isArray(entry.changes)) {
            for (const change of entry.changes) {
              if (change.field === 'comments' && change.value) {
                const comment = change.value;
                const authorName = (comment.from && comment.from.username) ? '@' + comment.from.username : 'متابع إنستغرام';
                const authorId = comment.from ? comment.from.id : null;
                const commentText = comment.text || '';
                const commentId = comment.id;
                const mediaId = comment.media ? comment.media.id : null;
                const createdTime = comment.timestamp || Date.now();

                // حماية رقم 1: منع الرد على حساب الإنستغرام نفسه
                const igId = data.settings && data.settings.instagramAccountId;
                const pageId = data.settings && data.settings.pageId;
                if (authorId && (authorId === igId || authorId === pageId)) {
                  console.log(`[درع الأمان] تم تجاهل تعليق حساب الإنستغرام نفسه.`);
                  continue;
                }

                const matchResult = matchCommentToRules(commentText, data.rules, authorName, 'instagram', mediaId, negativeList);

                if (matchResult && matchResult.isNegativeWarning) {
                  console.warn(`⚠️ [درع الأمان] تعليق سلبي على إنستغرام من (${authorName}). تم إيقاف الرد.`);
                  data.logs.unshift({
                    id: 'log_' + Date.now(),
                    timestamp: new Date().toISOString(),
                    platform: 'instagram',
                    postId: mediaId || 'all',
                    author: authorName,
                    comment: commentText,
                    matchedRule: '⚠️ تعليق سلبي/شكوى مستبعدة',
                    publicReply: 'تم الإلغاء تلقائياً لتجنب الاستفزاز',
                    privateReply: 'تنبيه: يتطلب رداً بشرياً خاصاً',
                    status: 'warning',
                    securityNote: 'فلتر حماية السمعة ومنع بلاغات السبام'
                  });
                  if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
                  saveData(data);
                  continue;
                }

                if (matchResult) {
                  antiBanQueue.enqueue({
                    platform: 'instagram',
                    commentId,
                    postId: mediaId,
                    authorName,
                    authorId,
                    createdTime,
                    commentText,
                    ruleName: matchResult.ruleName,
                    isPostSpecific: matchResult.isPostSpecific,
                    publicReply: matchResult.publicReply,
                    privateReply: matchResult.privateReply
                  });
                } else {
                  data.logs.unshift({
                    id: 'log_' + Date.now(),
                    timestamp: new Date().toISOString(),
                    platform: 'instagram',
                    postId: mediaId || 'unknown',
                    author: authorName,
                    comment: commentText,
                    matchedRule: 'لا توجد قاعدة مطابقة',
                    publicReply: 'تم التجاهل',
                    privateReply: '-',
                    status: 'skipped'
                  });
                  if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
                  saveData(data);
                }
              }
            }
          }
        }
      }

      return;
    } catch (err) {
      console.error('خطأ في معالجة إشعار Meta:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  // 3. مسارات واجهة التطبيق (API Endpoints)

  // أ) فحص إصدار التطبيق (للتحديث المباشر التلقائي)
  if (method === 'GET' && pathname === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      version: APP_VERSION,
      releaseDate: APP_RELEASE_DATE,
      appName: 'MetaPulse AutoReply',
      status: 'online'
    }));
    return;
  }

  // ب) مسارات الأمان والمصادقة (Auth & Security System)
  if (method === 'GET' && pathname === '/api/auth/status') {
    const data = loadData();
    const security = data.security || {};
    const auth = verifyAuth(req);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      isConfigured: !!security.pinHash,
      isAuthenticated: auth.authenticated,
      setupRequired: auth.setupRequired
    }));
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/setup') {
    const body = await parseRequestBody(req);
    const data = loadData();
    if (data.security && data.security.pinHash) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'ALREADY_CONFIGURED', message: 'تم تعيين رمز الحماية مسبقاً' }));
      return;
    }
    const pin = body.pin;
    if (!pin || String(pin).trim().length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'INVALID_PIN', message: 'رمز الحماية يجب أن يتكون من 4 خانات على الأقل' }));
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    data.security = {
      pinHash: hashPin(pin, salt),
      pinSalt: salt,
      appSecret: body.appSecret ? String(body.appSecret).trim() : '',
      createdAt: new Date().toISOString()
    };
    saveData(data);

    const token = generateSessionToken();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    activeSessions.set(token, { createdAt: Date.now(), expiresAt, ip: getClientIp(req) });

    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `mp_auth=${token}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`
    });
    res.end(JSON.stringify({ success: true, token, message: 'تم إعداد رمز الحماية بنجاح وتأمين التطبيق' }));
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const ip = getClientIp(req);
    if (isIpLocked(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'LOCKED', message: 'تم قفل الدخول مؤقتاً لمدة 15 دقيقة بعد 5 محاولات خاطئة لحماية النظام من التخمين.' }));
      return;
    }

    const body = await parseRequestBody(req);
    const data = loadData();
    const security = data.security || {};

    if (!security.pinHash) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'SETUP_REQUIRED', message: 'يرجى تهيئة رمز الحماية أولاً' }));
      return;
    }

    const userPin = body.pin;
    const testHash = hashPin(userPin, security.pinSalt);

    if (testHash === security.pinHash) {
      clearFailedLogins(ip);
      const token = generateSessionToken();
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
      activeSessions.set(token, { createdAt: Date.now(), expiresAt, ip });

      res.writeHead(200, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `mp_auth=${token}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`
      });
      res.end(JSON.stringify({ success: true, token, message: 'تم فتح لوحة التحكم بنجاح' }));
      return;
    } else {
      recordFailedLogin(ip);
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'INVALID_PIN', message: 'رمز الحماية غير صحيح. تحقق وحاول ثانية.' }));
      return;
    }
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      activeSessions.delete(authHeader.substring(7));
    }
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `mp_auth=; Path=/; Max-Age=0`
    });
    res.end(JSON.stringify({ success: true, message: 'تم تسجيل الخروج وقفل اللوحة' }));
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/change-pin') {
    const auth = verifyAuth(req);
    if (!auth.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'غير مصرح' }));
      return;
    }
    const body = await parseRequestBody(req);
    const data = loadData();
    const security = data.security || {};
    const oldPin = body.oldPin;
    const newPin = body.newPin;

    if (hashPin(oldPin, security.pinSalt) !== security.pinHash) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'INVALID_OLD_PIN', message: 'رمز الحماية الحالي غير صحيح' }));
      return;
    }
    if (!newPin || String(newPin).trim().length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'INVALID_NEW_PIN', message: 'الرمز الجديد يجب أن يكون 4 خانات على الأقل' }));
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    data.security.pinHash = hashPin(newPin, salt);
    data.security.pinSalt = salt;
    saveData(data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: 'تم تغيير رمز الحماية بنجاح' }));
    return;
  }

  // ج) النسخ الاحتياطي والاستعادة (Backup & Restore)
  if (method === 'GET' && pathname === '/api/backup') {
    const auth = verifyAuth(req);
    if (!auth.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return;
    }
    const data = loadData();
    const backupData = {
      app: 'MetaPulse AutoReply',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: data.settings,
      rules: data.rules,
      logs: data.logs.slice(0, 50)
    };
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="metapulse-backup-${Date.now()}.json"`
    });
    res.end(JSON.stringify(backupData, null, 2));
    return;
  }

  if (method === 'POST' && pathname === '/api/restore') {
    const auth = verifyAuth(req);
    if (!auth.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return;
    }
    const body = await parseRequestBody(req);
    if (!body || !body.rules || !body.settings) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'ملف النسخة الاحتياطية غير صالح' }));
      return;
    }
    const data = loadData();
    data.settings = body.settings;
    data.rules = body.rules;
    if (Array.isArray(body.logs)) data.logs = body.logs;
    saveData(data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: 'تمت استعادة البيانات بنجاح وبأمان كامل' }));
    return;
  }

  // د) حماية مسارات API من أي وصول غير مصرح
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/') && pathname !== '/api/version') {
    const auth = verifyAuth(req);
    if (!auth.authenticated && !auth.setupRequired) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'لوحة التحكم محمية. يرجى إدخال رمز PIN للمتابعة.' }));
      return;
    }
  }

  // محاكي التعليقات المباشر
  if (method === 'POST' && pathname === '/api/simulate-comment') {
    const body = await parseRequestBody(req);
    const data = loadData();
    const antiBan = (data.settings && data.settings.antiBan) || {};
    const platform = body.platform || 'facebook';
    const postId = body.postId || null;
    const authorName = body.author || (platform === 'instagram' ? '@sarah_art' : 'محمد أحمد');
    const commentText = body.comment || '';

    const negativeList = (antiBan.enableNegativeFilter) ? (antiBan.negativeKeywords || []) : [];
    const matchResult = matchCommentToRules(commentText, data.rules, authorName, platform, postId, negativeList);

    // حساب تأخير الأمان التجريبي
    const minDelay = antiBan.minDelaySeconds || 2;
    const maxDelay = antiBan.maxDelaySeconds || 5;
    const simulatedDelay = (Math.random() * (maxDelay - minDelay) + minDelay).toFixed(1);

    if (matchResult && matchResult.isNegativeWarning) {
      const logEntry = {
        id: 'sim_' + Date.now(),
        timestamp: new Date().toISOString(),
        platform: platform,
        postId: postId || 'all',
        author: authorName,
        comment: commentText,
        matchedRule: '⚠️ تعليق سلبي/شكوى تم رصدها',
        publicReply: 'تم حجب الرد التلقائي لحماية صفحتك من الإبلاغات',
        privateReply: 'تنبيه للإدارة: عميل غير راضٍ يحتاج تدخلاً بشرياً فورياً',
        delayUsed: '0 ثانية (حماية فورية)',
        status: 'warning',
        isSimulation: true,
        securityNote: 'فلتر الذكاء الاجتماعي وحماية السمعة'
      };

      data.logs.unshift(logEntry);
      if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
      saveData(data);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        matched: false,
        isNegativeWarning: true,
        log: logEntry,
        message: 'تم كشف شكوى/كلمات سلبية! درع الأمان أوقف الرد الآلي لحماية الصفحة.'
      }));
      return;
    }

    const logEntry = {
      id: 'sim_' + Date.now(),
      timestamp: new Date().toISOString(),
      platform: platform,
      postId: postId || 'all',
      author: authorName,
      comment: commentText,
      matchedRule: matchResult 
        ? matchResult.ruleName + (matchResult.isPostSpecific ? ' 🎯 [رد مخصص للمنشور]' : ' 🌐 [رد عام لكل المنشورات]') 
        : 'لا توجد قاعدة مطابقة',
      publicReply: matchResult ? matchResult.publicReply : 'لم يتم الرد (لا توجد كلمة مفتاحية مطابقة)',
      privateReply: matchResult ? matchResult.privateReply : '-',
      delayUsed: `${simulatedDelay} ثانية`,
      status: matchResult ? 'success' : 'skipped',
      isSimulation: true,
      securityNote: 'محمي بدرع الأمان وتنوع الكلمات'
    };

    data.logs.unshift(logEntry);
    if (data.logs.length > 100) data.logs = data.logs.slice(0, 100);
    saveData(data);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      matched: !!matchResult,
      result: matchResult,
      log: logEntry,
      simulatedDelay
    }));
    return;
  }

  // جلب القواعد
  if (method === 'GET' && pathname === '/api/rules') {
    const data = loadData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data.rules || []));
    return;
  }

  // إضافة أو تعديل قاعدة
  if (method === 'POST' && pathname === '/api/rules') {
    const body = await parseRequestBody(req);
    const data = loadData();

    if (!body.name || !body.keywords || !body.keywords.length) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'اسم القاعدة والكلمات المفتاحية مطلوبة' }));
      return;
    }

    if (body.id) {
      const index = data.rules.findIndex(r => r.id === body.id);
      if (index !== -1) {
        data.rules[index] = { ...data.rules[index], ...body };
      }
    } else {
      const newRule = {
        id: 'rule_' + Date.now(),
        name: body.name,
        platform: body.platform || 'both',
        postScope: body.postScope || 'all',
        postId: body.postId ? String(body.postId).trim() : '',
        keywords: Array.isArray(body.keywords) ? body.keywords : body.keywords.split(',').map(s => s.trim()).filter(Boolean),
        publicReplies: Array.isArray(body.publicReplies) ? body.publicReplies : [body.publicReplies || 'تم الرد في الخاص 📩'],
        privateReply: body.privateReply || 'أهلاً بك، تم إرسال التفاصيل.',
        isActive: body.isActive !== undefined ? body.isActive : true
      };
      data.rules.push(newRule);
    }

    saveData(data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, rules: data.rules }));
    return;
  }

  // حذف قاعدة
  if (method === 'DELETE' && pathname.startsWith('/api/rules/')) {
    const ruleId = pathname.replace('/api/rules/', '');
    const data = loadData();
    data.rules = data.rules.filter(r => r.id !== ruleId);
    saveData(data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, rules: data.rules }));
    return;
  }

  // تبديل حالة التفعيل
  if (method === 'POST' && pathname.startsWith('/api/rules/') && pathname.endsWith('/toggle')) {
    const ruleId = pathname.split('/')[3];
    const data = loadData();
    const rule = data.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.isActive = !rule.isActive;
      saveData(data);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, rules: data.rules }));
    return;
  }

  // جلب السجلات
  if (method === 'GET' && pathname === '/api/logs') {
    const data = loadData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data.logs || []));
    return;
  }

  // مسح السجلات
  if (method === 'DELETE' && pathname === '/api/logs') {
    const data = loadData();
    data.logs = [];
    saveData(data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // جلب وتحديث الإعدادات (بما في ذلك Anti-Ban ومفتاح الأمان)
  if (method === 'GET' && pathname === '/api/settings') {
    const data = loadData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ...data.settings,
      appSecret: (data.security && data.security.appSecret) || ''
    }));
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await parseRequestBody(req);
    const data = loadData();
    if (body.appSecret !== undefined) {
      if (!data.security) data.security = {};
      data.security.appSecret = String(body.appSecret).trim();
      delete body.appSecret;
    }
    data.settings = { ...data.settings, ...body };
    saveData(data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ 
      success: true, 
      settings: {
        ...data.settings,
        appSecret: (data.security && data.security.appSecret) || ''
      }
    }));
    return;
  }

  // تبديل حالة زر الطوارئ اللحظي (Emergency Stop Toggle)
  if (method === 'POST' && pathname === '/api/emergency-stop/toggle') {
    const data = loadData();
    if (!data.settings) data.settings = {};
    if (!data.settings.antiBan) data.settings.antiBan = {};
    
    data.settings.antiBan.emergencyStop = !data.settings.antiBan.emergencyStop;
    saveData(data);

    const isStopped = data.settings.antiBan.emergencyStop;
    console.log(`[زر الطوارئ] تم ${isStopped ? 'تفعيل الإيقاف الشامل للردود 🛑' : 'استئناف عمل الردود التلقائية ✅'}`);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ 
      success: true, 
      emergencyStop: isStopped,
      message: isStopped ? 'تم إيقاف الردود فوراً بنجاح' : 'تم استئناف الردود التلقائية بأمان'
    }));
    return;
  }

  // إحصائيات عامة
  if (method === 'GET' && pathname === '/api/stats') {
    const data = loadData();
    const totalProcessed = data.logs.length;
    const successfulReplies = data.logs.filter(l => l.status === 'success').length;
    const activeRulesCount = data.rules.filter(r => r.isActive).length;
    const postSpecificRulesCount = data.rules.filter(r => r.postScope === 'specific').length;
    const antiBan = (data.settings && data.settings.antiBan) || {};

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      totalProcessed,
      successfulReplies,
      activeRulesCount,
      totalRulesCount: data.rules.length,
      postSpecificRulesCount,
      queuePending: antiBanQueue.queue.length,
      antiBanActive: !!antiBan.enabled,
      emergencyStop: !!antiBan.emergencyStop,
      hourlyRepliesCount: antiBanQueue.velocityTracker.getHourlyCount(),
      maxRepliesPerHour: antiBan.maxRepliesPerHour || 150,
      isLiveConfigured: !!(data.settings && data.settings.pageAccessToken)
    }));
    return;
  }

  // تقديم الملفات الثابتة
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, fallback) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('الصفحة غير موجودة');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fallback);
          }
        });
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + err.code);
      }
    } else {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🛡️ خادم أتمتة الردود مع درع الحماية من الحظر (Anti-Ban Active) يعمل بنجاح!`);
  console.log(`📡 لوحة التحكم المباشرة: http://localhost:${PORT}`);
  console.log(`🔗 رابط الـ Webhook الموحد لـ Meta: http://localhost:${PORT}/webhook`);
  console.log(`======================================================\n`);
});
