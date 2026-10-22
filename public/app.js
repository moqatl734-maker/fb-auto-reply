/* =========================================================
   MetaPulse AutoReply - منطق لوحة التحكم مع درع الحماية ومكافحة الحظر
   Vanilla JavaScript
   ========================================================= */

document.addEventListener('DOMContentLoaded', () => {
  const CLIENT_VERSION = '2.2.0';
  let isSetupMode = false;
  let isAppInitialized = false;

  // اعتراض الطلبات لتمرير رمز التوثيق الأمني تلقائياً ومعالجة انتهاء الجلسة
  const originalFetch = window.fetch;
  window.fetch = function(input, init = {}) {
    init.headers = init.headers || {};
    const token = localStorage.getItem('mp_auth_token');
    if (token && typeof input === 'string' && input.startsWith('/api/')) {
      if (init.headers instanceof Headers) {
        init.headers.set('Authorization', 'Bearer ' + token);
      } else {
        init.headers['Authorization'] = 'Bearer ' + token;
      }
    }
    return originalFetch.call(this, input, init).then(res => {
      if (res.status === 401 && typeof input === 'string' && !input.includes('/api/auth/')) {
        showPinLockScreen(false);
      }
      return res;
    });
  };

  let appState = {
    rules: [],
    logs: [],
    settings: {},
    stats: {}
  };

  let currentSimulatorPlatform = 'facebook';
  let deferredPrompt = null;

  // -------------------------------------------------------------
  // 1. تسجيل تطبيق الهاتف (Service Worker & PWA Install)
  // -------------------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        console.log('✅ تم تسجيل Service Worker لتطبيق الهاتف بنجاح:', reg.scope);
      }).catch(err => {
        console.log('فشل تسجيل Service Worker:', err);
      });
    });
  }

  const btnInstallApp = document.getElementById('btn-install-app');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnInstallApp) {
      btnInstallApp.style.display = 'inline-flex';
    }
  });

  if (btnInstallApp) {
    btnInstallApp.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        btnInstallApp.style.display = 'none';
      }
      deferredPrompt = null;
    });
  }

  // -------------------------------------------------------------
  // 2. إدارة التبويبات (Sidebar + Mobile Bottom Nav)
  // -------------------------------------------------------------
  const navButtons = document.querySelectorAll('.sidebar-nav .nav-item');
  const mobileNavButtons = document.querySelectorAll('.mobile-bottom-nav .mobile-nav-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  function switchTab(targetTab) {
    navButtons.forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-tab') === targetTab);
    });

    mobileNavButtons.forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-tab') === targetTab);
    });

    tabPanes.forEach(p => {
      p.classList.toggle('active', p.id === targetTab);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  mobileNavButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  const btnViewAllRules = document.getElementById('btn-view-all-rules');
  if (btnViewAllRules) {
    btnViewAllRules.addEventListener('click', () => {
      switchTab('tab-rules');
    });
  }

  // -------------------------------------------------------------
  // 3. محاكي المنشورات والمنصات (Post Selector & Platform)
  // -------------------------------------------------------------
  const simTabFb = document.getElementById('sim-tab-fb');
  const simTabIg = document.getElementById('sim-tab-ig');
  const simTargetPost = document.getElementById('sim-target-post');
  const mockupContainer = document.getElementById('simulator-mockup-container');
  const mockupAvatar = document.getElementById('mockup-avatar');
  const mockupAuthor = document.getElementById('mockup-author-name');
  const mockupPostType = document.getElementById('mockup-post-type');
  const mockupBody = document.getElementById('mockup-body-text');
  const simAuthorInput = document.getElementById('sim-author-name');
  const btnSubmitSim = document.getElementById('btn-submit-simulation');
  const simQuickChips = document.getElementById('sim-quick-chips');

  // -------------------------------------------------------------
  // 3. محاكي المنشورات والتعليقات التفاعلي الديناميكي
  // -------------------------------------------------------------
  function updateSimulatorPostPicker(selectedPostIdToKeep = null) {
    if (!simTargetPost) return;

    const currentVal = selectedPostIdToKeep || simTargetPost.value || 'all';
    const rules = appState.rules || [];

    // استخراج المنشورات المخصصة الفريدة من القواعد
    const specificPostsMap = new Map();
    rules.forEach(rule => {
      if (rule.postScope === 'specific' && rule.postId) {
        const key = rule.postId.trim();
        if (!specificPostsMap.has(key)) {
          specificPostsMap.set(key, {
            postId: key,
            ruleNames: [rule.name],
            platform: rule.platform,
            keywords: [...rule.keywords]
          });
        } else {
          const item = specificPostsMap.get(key);
          if (!item.ruleNames.includes(rule.name)) item.ruleNames.push(rule.name);
          item.keywords = Array.from(new Set([...item.keywords, ...rule.keywords]));
        }
      }
    });

    let optionsHtml = '';

    // المنشورات المخصصة
    if (specificPostsMap.size > 0) {
      optionsHtml += '<optgroup label="🎯 منشورات مخصصة (بقواعد حصرية)">';
      specificPostsMap.forEach((info, postId) => {
        const icon = info.platform === 'instagram' ? '🟣' : (info.platform === 'facebook' ? '🔵' : '🎯');
        const title = info.ruleNames.join(' + ');
        optionsHtml += `<option value="${escapeHtml(postId)}">${icon} ${escapeHtml(title)} (#${escapeHtml(postId)})</option>`;
      });
      optionsHtml += '</optgroup>';
    }

    // المنشور العام
    optionsHtml += '<optgroup label="🌐 منشورات الصفحة العامة">';
    optionsHtml += '<option value="all">🌐 منشور عام (تنطبق عليه القواعد العامة لجميع المنشورات)</option>';
    optionsHtml += '</optgroup>';

    simTargetPost.innerHTML = optionsHtml;

    // استعادة الاختيار المطلوب أو الحفاظ على الحالي
    const hasMatch = Array.from(simTargetPost.options).some(opt => opt.value === currentVal);
    if (hasMatch) {
      simTargetPost.value = currentVal;
    } else if (simTargetPost.options.length > 0) {
      simTargetPost.selectedIndex = 0;
    }

    updateMockupPostContent();
  }

  function updateMockupPostContent() {
    if (!simTargetPost) return;
    const selectedPost = simTargetPost.value;
    const rules = appState.rules || [];

    // البحث عن قاعدة تطابق هذا المنشور المحدد
    const matchedRule = rules.find(r => r.postScope === 'specific' && r.postId === selectedPost);

    // إذا كانت القاعدة حصرية لمنصة معينة، نوائم المنصة بالمحاكي تلقائياً
    if (matchedRule && matchedRule.platform && matchedRule.platform !== 'both') {
      if (matchedRule.platform === 'instagram' && currentSimulatorPlatform !== 'instagram') {
        setSimulatorPlatform('instagram');
        return;
      } else if (matchedRule.platform === 'facebook' && currentSimulatorPlatform !== 'facebook') {
        setSimulatorPlatform('facebook');
        return;
      }
    }

    if (selectedPost === 'post_watches') {
      mockupPostType.textContent = currentSimulatorPlatform === 'instagram' 
        ? 'ريلز الساعات · نُشر منذ أسبوعين (منشور قديم) · 🎵' 
        : 'منشور ممول للساعات · نُشر منذ أسبوعين (منشور قديم) · 🌐';
      mockupBody.innerHTML = `⌚ <strong>عرض الساعات الفاخرة (المنشور القديم):</strong> احصل على الساعة الكلاسيكية الفاخرة بخصم خاص وضمان سنة كاملة! اكتب (السعر) في التعليقات لمعرفة السعر الفوري.`;
      renderQuickChipsForPost(matchedRule ? matchedRule.keywords : ['سعر', 'السعر', 'بكم', 'كام']);
    } else if (selectedPost === 'post_perfumes') {
      mockupPostType.textContent = currentSimulatorPlatform === 'instagram' 
        ? 'ريلز العطور · نُشر اليوم (منشور جديد) · 🎵' 
        : 'منشور ممول للعطور · نُشر اليوم (منشور جديد) · 🌐';
      mockupBody.innerHTML = `🌸 <strong>عرض العطور الفرنسية (المنشور الجديد):</strong> بكج 3 زجاجات فاخرة بسعر حصري وثبات أكثر من 24 ساعة! اكتب (السعر) لمعرفة العرض والتوصيل المجاني.`;
      renderQuickChipsForPost(matchedRule ? matchedRule.keywords : ['سعر', 'السعر', 'بكم', 'كام']);
    } else if (matchedRule) {
      // أي قاعدة جديدة يضيفها المستخدم لمنشور محدد
      const platformLabel = matchedRule.platform === 'instagram' ? 'إنستغرام' : (matchedRule.platform === 'facebook' ? 'فيسبوك' : 'فيسبوك وإنستغرام');
      mockupPostType.textContent = `منشور مخصص · ${platformLabel} · المعرّف: #${escapeHtml(matchedRule.postId)} · 🎯`;
      
      const firstPublic = (matchedRule.publicReplies && matchedRule.publicReplies[0])
        ? matchedRule.publicReplies[0].replace(/{user}/g, 'العميل')
        : 'مرحباً بك! تواصل معنا لمعرفة التفاصيل.';

      mockupBody.innerHTML = `📢 <strong>${escapeHtml(matchedRule.name)}:</strong><br>${escapeHtml(firstPublic)}<br><small style="color:var(--text-muted);margin-top:8px;display:block;">🔑 كلمات الرد المبرمجة: ${escapeHtml(matchedRule.keywords.join(' ، '))}</small>`;
      renderQuickChipsForPost(matchedRule.keywords);
    } else {
      // منشور عام
      mockupPostType.textContent = 'منشور عام للصفحة · 🌐';
      mockupBody.innerHTML = `🎉 <strong>عروض المتجر العامة:</strong> تشكيلة واسعة من المنتجات الحصرية بأسعار مميزة. اترك تعليقاً بأي استفسار وسنرد عليك فوراً!`;
      
      const generalKeywords = [];
      rules.filter(r => r.postScope !== 'specific').forEach(r => {
        (r.keywords || []).forEach(kw => {
          if (!generalKeywords.includes(kw) && generalKeywords.length < 5) generalKeywords.push(kw);
        });
      });
      if (!generalKeywords.length) generalKeywords.push('سعر', 'بكم', 'وين موقعكم');
      renderQuickChipsForPost(generalKeywords);
    }
  }

  function renderQuickChipsForPost(keywords = []) {
    if (!simQuickChips) return;
    const chips = keywords.slice(0, 4);
    let chipsHtml = '<span>اقتراحات سريعة:</span>';
    chips.forEach(kw => {
      chipsHtml += `<button type="button" class="chip-btn" data-text="${escapeHtml(kw)}">${escapeHtml(kw)}</button>`;
    });
    chipsHtml += `<button type="button" class="chip-btn" data-text="نصابين وين طلبي" style="border-color: rgba(239, 68, 68, 0.4); color: #f87171;">⚠️ تجربة كلمة سلبية</button>`;
    simQuickChips.innerHTML = chipsHtml;
    bindChipButtons();
  }

  simTargetPost.addEventListener('change', updateMockupPostContent);

  function setSimulatorPlatform(platform) {
    currentSimulatorPlatform = platform;

    if (platform === 'instagram') {
      simTabIg.classList.add('active');
      simTabFb.classList.remove('active');

      mockupContainer.classList.add('is-instagram');
      mockupAvatar.classList.add('is-instagram');
      mockupAvatar.textContent = '📸';
      mockupAuthor.textContent = 'متجري الرسمي (@mystore)';
      simAuthorInput.value = '@sarah_designer';
      btnSubmitSim.classList.add('ig-btn');
    } else {
      simTabFb.classList.add('active');
      simTabIg.classList.remove('active');

      mockupContainer.classList.remove('is-instagram');
      mockupAvatar.classList.remove('is-instagram');
      mockupAvatar.textContent = 'M';
      mockupAuthor.textContent = 'صفحتي الرسمية';
      simAuthorInput.value = 'محمد أحمد';
      btnSubmitSim.classList.remove('ig-btn');
    }

    updateMockupPostContent();
  }

  simTabFb.addEventListener('click', () => setSimulatorPlatform('facebook'));
  simTabIg.addEventListener('click', () => setSimulatorPlatform('instagram'));

  function bindChipButtons() {
    document.querySelectorAll('.chip-btn').forEach(chip => {
      chip.addEventListener('click', () => {
        const simComment = document.getElementById('sim-comment-text');
        simComment.value = chip.getAttribute('data-text');
        simComment.focus();
      });
    });
  }

  // -------------------------------------------------------------
  // 4. جلب البيانات من الخادم
  // -------------------------------------------------------------
  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const stats = await res.json();
      appState.stats = stats;

      document.getElementById('stat-total-processed').textContent = stats.totalProcessed;
      document.getElementById('stat-successful-replies').textContent = stats.successfulReplies;
      document.getElementById('stat-post-rules-count').textContent = stats.postSpecificRulesCount || 0;
      
      const antiBanStatus = document.getElementById('stat-anti-ban-status');
      const btnEmergency = document.getElementById('btn-emergency-stop');
      const headerShield = document.getElementById('header-shield-chip');
      const webhookPortText = document.getElementById('webhook-port-text');

      if (stats.emergencyStop) {
        if (antiBanStatus) {
          antiBanStatus.textContent = 'إيقاف طوارئ 🛑';
          antiBanStatus.style.color = '#ef4444';
        }
        if (btnEmergency) {
          btnEmergency.classList.add('is-stopped');
          document.getElementById('emergency-btn-text').textContent = 'استئناف الردود (متوقف ⚠️)';
        }
        if (headerShield) {
          headerShield.innerHTML = '<span style="color:#ef4444;">🛑 متوقف بطلب الإدارة</span>';
        }
      } else {
        if (antiBanStatus) {
          antiBanStatus.textContent = 'نشط ومحمي 🛡️';
          antiBanStatus.style.color = '#10b981';
        }
        if (btnEmergency) {
          btnEmergency.classList.remove('is-stopped');
          document.getElementById('emergency-btn-text').textContent = 'إيقاف الطوارئ';
        }
        if (headerShield) {
          headerShield.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            درع الأمان مفعل 100%
          `;
        }
      }

      if (webhookPortText) {
        webhookPortText.textContent = `سرعة آمنة: ${stats.hourlyRepliesCount || 0}/${stats.maxRepliesPerHour || 150} بالساعة`;
      }
    } catch (err) {
      console.error('فشل جلب الإحصائيات:', err);
    }
  }

  async function fetchRules() {
    try {
      const res = await fetch('/api/rules');
      const rules = await res.json();
      appState.rules = rules;

      document.getElementById('badge-rules-count').textContent = rules.length;
      renderQuickRules(rules);
      renderAllRules(rules);
      updateSimulatorPostPicker();
    } catch (err) {
      console.error('فشل جلب القواعد:', err);
    }
  }

  async function fetchLogs() {
    try {
      const res = await fetch('/api/logs');
      const logs = await res.json();
      appState.logs = logs;

      document.getElementById('badge-logs-count').textContent = logs.length;
      renderLogsTable(logs);
    } catch (err) {
      console.error('فشل جلب السجلات:', err);
    }
  }

  async function fetchSettings() {
    try {
      const res = await fetch('/api/settings');
      const settings = await res.json();
      appState.settings = settings;

      if (settings.verifyToken) {
        document.getElementById('setting-verify-token').value = settings.verifyToken;
      }
      if (settings.pageId) {
        document.getElementById('setting-page-id').value = settings.pageId;
      }
      if (settings.instagramAccountId) {
        document.getElementById('setting-ig-account-id').value = settings.instagramAccountId;
      }
      if (settings.pageAccessToken) {
        document.getElementById('setting-page-token').value = settings.pageAccessToken;
      }
      document.getElementById('setting-live-toggle').checked = !!settings.enableLiveGraphApi;

      // إعدادات درع الحماية Anti-Ban
      const antiBan = settings.antiBan || {};
      document.getElementById('antiban-enabled').checked = antiBan.enabled !== false;
      document.getElementById('antiban-min-delay').value = antiBan.minDelaySeconds || 2;
      document.getElementById('antiban-max-delay').value = antiBan.maxDelaySeconds || 5;
      
      const maxPerHourInput = document.getElementById('antiban-max-per-hour');
      if (maxPerHourInput) maxPerHourInput.value = antiBan.maxRepliesPerHour || 150;

      document.getElementById('antiban-user-cooldown').checked = antiBan.enableUserCooldown !== false;
      document.getElementById('antiban-deduplication').checked = antiBan.enableDeduplication !== false;
      
      const enforce7DaysInput = document.getElementById('antiban-enforce-7days');
      if (enforce7DaysInput) enforce7DaysInput.checked = antiBan.enforce7DayPolicy !== false;

      const negativeFilterInput = document.getElementById('antiban-negative-filter');
      if (negativeFilterInput) negativeFilterInput.checked = antiBan.enableNegativeFilter !== false;

      const negativeKeywordsInput = document.getElementById('antiban-negative-keywords');
      if (negativeKeywordsInput) negativeKeywordsInput.value = (antiBan.negativeKeywords || []).join(', ');

      document.getElementById('antiban-auto-backoff').checked = antiBan.autoBackoffOnLimit !== false;

      const appSecretInput = document.getElementById('setting-app-secret');
      if (appSecretInput && settings.appSecret) {
        appSecretInput.value = settings.appSecret;
      }

    } catch (err) {
      console.error('فشل جلب الإعدادات:', err);
    }
  }

  // -------------------------------------------------------------
  // 5. عرض القواعد والبطاقات (Render Rules)
  // -------------------------------------------------------------
  function getPlatformBadge(platform) {
    if (platform === 'instagram') return '<span class="rule-platform-tag instagram">إنستغرام</span>';
    if (platform === 'facebook') return '<span class="rule-platform-tag facebook">فيسبوك</span>';
    return '<span class="rule-platform-tag both">فيسبوك + إنستغرام</span>';
  }

  function getScopeBadge(rule) {
    if (rule.postScope === 'specific') {
      return `<span class="rule-scope-tag specific">🎯 مخصص للمنشور: ${escapeHtml(rule.postId || 'محدد')}</span>`;
    }
    return '<span class="rule-scope-tag all">🌐 كل المنشورات</span>';
  }

  function renderQuickRules(rules) {
    const container = document.getElementById('quick-rules-container');
    if (!rules || rules.length === 0) {
      container.innerHTML = '<div class="helper-text text-center">لا توجد قواعد مضافة حتى الآن.</div>';
      return;
    }

    container.innerHTML = rules.map(rule => `
      <div class="quick-rule-item">
        <div class="rule-info">
          <h4>${escapeHtml(rule.name)}</h4>
          <div class="rule-meta-tags">
            ${getPlatformBadge(rule.platform)}
            ${getScopeBadge(rule)}
            ${rule.keywords.slice(0, 3).map(kw => `<span class="rule-tag">${escapeHtml(kw)}</span>`).join('')}
          </div>
        </div>
        <label class="switch" title="${rule.isActive ? 'تعطيل القاعدة' : 'تفعيل القاعدة'}">
          <input type="checkbox" class="toggle-rule-btn" data-id="${rule.id}" ${rule.isActive ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    `).join('');

    container.querySelectorAll('.toggle-rule-btn').forEach(input => {
      input.addEventListener('change', async (e) => {
        const id = e.target.getAttribute('data-id');
        await toggleRule(id);
      });
    });
  }

  function renderAllRules(rules) {
    const container = document.getElementById('all-rules-container');
    if (!rules || rules.length === 0) {
      container.innerHTML = '<div class="helper-text text-center">لا توجد قواعد مضافة حتى الآن. اضغط على "إضافة قاعدة رد جديدة".</div>';
      return;
    }

    container.innerHTML = rules.map(rule => `
      <div class="rule-full-card">
        <div class="rule-card-top">
          <div class="rule-title-group">
            <h3>${escapeHtml(rule.name)}</h3>
            <div class="rule-meta-tags">
              ${getPlatformBadge(rule.platform)}
              ${getScopeBadge(rule)}
            </div>
          </div>
          <div class="rule-header-controls">
            <label class="switch" title="${rule.isActive ? 'تعطيل القاعدة' : 'تفعيل القاعدة'}">
              <input type="checkbox" class="toggle-rule-btn" data-id="${rule.id}" ${rule.isActive ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="rule-keywords-row">
          <span class="kw-icon">🔑</span>
          ${rule.keywords.map(kw => `<span class="rule-tag">${escapeHtml(kw)}</span>`).join('')}
        </div>

        <div class="rule-preview-box">
          <div class="preview-item">
            <span class="preview-badge public">💬 رد عام</span>
            <span class="preview-text">${escapeHtml(rule.publicReplies ? rule.publicReplies.join(' • ') : 'تم الرد في الخاص 📩')}</span>
          </div>
          <div class="preview-item">
            <span class="preview-badge private">📩 خاص</span>
            <span class="preview-text">${escapeHtml(rule.privateReply || '-')}</span>
          </div>
        </div>

        <div class="rule-card-actions">
          <button class="btn btn-sm btn-outline edit-rule-btn" data-id="${rule.id}">✏️ تعديل</button>
          <button class="btn btn-sm btn-primary test-rule-sim-btn" data-id="${rule.id}">🎯 تجربة في المحاكي</button>
          <button class="btn btn-sm btn-danger-outline delete-rule-btn" data-id="${rule.id}">🗑️ حذف</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.toggle-rule-btn').forEach(input => {
      input.addEventListener('change', async (e) => {
        const id = e.target.getAttribute('data-id');
        await toggleRule(id);
      });
    });

    container.querySelectorAll('.edit-rule-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openEditRuleModal(id);
      });
    });

    container.querySelectorAll('.test-rule-sim-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const rule = appState.rules.find(r => r.id === id);
        if (!rule) return;

        // ضبط منصة المحاكي
        if (rule.platform === 'instagram') {
          setSimulatorPlatform('instagram');
        } else {
          setSimulatorPlatform('facebook');
        }

        // اختيار المنشور المستهدف وتحديث المحاكي
        const targetPost = (rule.postScope === 'specific' && rule.postId) ? rule.postId : 'all';
        updateSimulatorPostPicker(targetPost);

        // وضع أول كلمة مفتاحية في صندوق التعليق لتسهيل التجربة
        const simComment = document.getElementById('sim-comment-text');
        if (simComment && rule.keywords && rule.keywords.length > 0) {
          simComment.value = rule.keywords[0];
        }

        // الانتقال الفوري لتبويب المحاكي
        switchTab('tab-overview');
        const mockupEl = document.getElementById('simulator-mockup-container');
        if (mockupEl) {
          mockupEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });

    container.querySelectorAll('.delete-rule-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (confirm('هل أنت متأكد من حذف هذه القاعدة؟')) {
          await deleteRule(id);
        }
      });
    });
  }

  // -------------------------------------------------------------
  // 6. عرض سجل العمليات (Render Logs)
  // -------------------------------------------------------------
  function renderLogsTable(logs) {
    const tbody = document.getElementById('logs-table-body');
    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">لا توجد عمليات مسجلة حتى الآن.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(log => {
      const date = new Date(log.timestamp);
      const timeStr = date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const isSuccess = log.status === 'success';

      let platformLabel = '<span class="rule-platform-tag facebook">فيسبوك</span>';
      if (log.platform === 'instagram') {
        platformLabel = '<span class="rule-platform-tag instagram">إنستغرام</span>';
      } else if (log.platform === 'both') {
        platformLabel = '<span class="rule-platform-tag both">موحد</span>';
      }

      const postBadge = log.postId && log.postId !== 'all' && log.postId !== 'unknown'
        ? `<span class="rule-scope-tag specific">#${escapeHtml(log.postId)}</span>`
        : `<span class="rule-scope-tag all">عام</span>`;

      return `
        <tr>
          <td><small>${timeStr}</small></td>
          <td>${platformLabel}</td>
          <td>${postBadge}</td>
          <td><strong>${escapeHtml(log.author || 'زائر')}</strong></td>
          <td>${escapeHtml(log.comment || '-')}</td>
          <td><span class="rule-tag">${escapeHtml(log.matchedRule || '-')}</span></td>
          <td><small class="badge-shield-log">${escapeHtml(log.delayUsed || '2.3 ثانية')}</small></td>
          <td>
            <span class="status-pill ${isSuccess ? 'success' : 'skipped'}">
              ${isSuccess ? 'محمي وآمن ✓' : 'تم التجاهل'}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  }

  // -------------------------------------------------------------
  // 7. تشغيل المحاكي (Simulator Submit)
  // -------------------------------------------------------------
  const simComment = document.getElementById('sim-comment-text');
  const simResultBox = document.getElementById('sim-result-container');
  const simMatchBadge = document.getElementById('sim-match-badge');
  const simDelayBadge = document.getElementById('sim-delay-badge');
  const simPublicText = document.getElementById('sim-public-reply-text');
  const simPrivateText = document.getElementById('sim-private-reply-text');
  const simPrivateBadge = document.getElementById('sim-private-badge');
  const simPrivateBubble = document.getElementById('sim-private-bubble');

  btnSubmitSim.addEventListener('click', async () => {
    const comment = simComment.value.trim();
    const author = simAuthorInput.value.trim() || (currentSimulatorPlatform === 'instagram' ? '@sarah_art' : 'محمد أحمد');
    const selectedPostId = simTargetPost.value;

    if (!comment) {
      alert('يرجى كتابة نص التعليق أولاً!');
      return;
    }

    btnSubmitSim.disabled = true;
    btnSubmitSim.innerHTML = '<span>جاري مطابقة المنشور وتطبيق درع الأمان...</span>';

    try {
      const res = await fetch('/api/simulate-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          comment, 
          author,
          platform: currentSimulatorPlatform,
          postId: selectedPostId
        })
      });
      const data = await res.json();

      simResultBox.style.display = 'block';

      if (currentSimulatorPlatform === 'instagram') {
        simPrivateBubble.classList.add('is-instagram');
        simPrivateBadge.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
          2. رسالة إنستغرام الخاصة الفورية (Instagram Direct Message)
        `;
      } else {
        simPrivateBubble.classList.remove('is-instagram');
        simPrivateBadge.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.145 2 11.258c0 2.91 1.455 5.514 3.737 7.21v3.532l3.39-1.86a10.875 10.875 0 0 0 2.873.388c5.523 0 10-4.145 10-9.27S17.523 2 12 2zm1.002 12.438l-2.55-2.723-4.975 2.723 5.474-5.812 2.613 2.723 4.912-2.723-5.474 5.812z"/></svg>
          2. رسالة ماسنجر فيسبوك الخاصة (Facebook Messenger)
        `;
      }

      if (data.isNegativeWarning) {
        simMatchBadge.className = 'badge badge-skipped';
        simMatchBadge.style.background = 'rgba(239, 68, 68, 0.2)';
        simMatchBadge.style.color = '#f87171';
        simMatchBadge.textContent = '🛑 تعليق سلبي - حُجب الرد فوراً';
        simDelayBadge.textContent = `🛡️ حماية سمعة 0s`;
        simPublicText.innerHTML = `<span style="color: #fbbf24; font-weight: 700;">⚠️ ${escapeHtml(data.message)}</span>`;
        simPrivateText.textContent = 'تم إلغاء الرسالة الخاصة لحماية الصفحة من البلاغات.';
      } else if (data.matched) {
        simMatchBadge.className = 'badge badge-success';
        simMatchBadge.style.background = '';
        simMatchBadge.style.color = '';
        simMatchBadge.textContent = data.result.isPostSpecific 
          ? `🎯 رد مخصص (${data.result.ruleName})`
          : `🌐 رد عام (${data.result.ruleName})`;
        simDelayBadge.textContent = `🛡️ تأخير بشري: ${data.simulatedDelay} ث`;
        simPublicText.textContent = data.result.publicReply;
        simPrivateText.textContent = data.result.privateReply;
      } else {
        simMatchBadge.className = 'badge badge-skipped';
        simMatchBadge.style.background = '';
        simMatchBadge.style.color = '';
        simMatchBadge.textContent = '⚠️ لم تطابق أي كلمة مفتاحية';
        simDelayBadge.textContent = `🛡️ محمي`;
        simPublicText.textContent = 'لم يتم نشر رد عام';
        simPrivateText.textContent = 'لم يتم إرسال رسالة خاصة';
      }

      fetchStats();
      fetchLogs();
    } catch (err) {
      alert('حدث خطأ أثناء المحاكاة: ' + err.message);
    } finally {
      btnSubmitSim.disabled = false;
      btnSubmitSim.innerHTML = `
        <span>إرسال التعليق التجريبي</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
      `;
    }
  });

  // -------------------------------------------------------------
  // 8. إدارة القواعد ونطاق المنشورات
  // -------------------------------------------------------------
  async function toggleRule(id) {
    try {
      const res = await fetch(`/api/rules/${id}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        fetchRules();
        fetchStats();
      }
    } catch (err) {
      console.error('خطأ في تبديل حالة القاعدة:', err);
    }
  }

  async function deleteRule(id) {
    try {
      const res = await fetch(`/api/rules/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        await fetchRules();
        fetchStats();
        updateSimulatorPostPicker();
      }
    } catch (err) {
      console.error('خطأ في حذف القاعدة:', err);
    }
  }

  const modal = document.getElementById('rule-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const btnCancelModal = document.getElementById('btn-cancel-modal');
  const ruleForm = document.getElementById('rule-form');
  const btnOpenCreate = document.getElementById('btn-open-create-modal');
  const btnQuickNewRule = document.getElementById('btn-quick-new-rule');
  const formRuleScope = document.getElementById('form-rule-scope');
  const formPostIdGroup = document.getElementById('form-post-id-group');

  formRuleScope.addEventListener('change', () => {
    formPostIdGroup.style.display = formRuleScope.value === 'specific' ? 'block' : 'none';
  });

  function openCreateRuleModal() {
    ruleForm.reset();
    document.getElementById('form-rule-id').value = '';
    document.getElementById('form-rule-platform').value = 'both';
    formRuleScope.value = 'all';
    formPostIdGroup.style.display = 'none';
    document.getElementById('form-rule-active').checked = true;
    document.getElementById('modal-title').textContent = 'إضافة قاعدة رد جديدة';
    modal.style.display = 'flex';
  }

  function openEditRuleModal(id) {
    const rule = appState.rules.find(r => r.id === id);
    if (!rule) return;

    document.getElementById('form-rule-id').value = rule.id;
    document.getElementById('form-rule-name').value = rule.name;
    document.getElementById('form-rule-platform').value = rule.platform || 'both';
    
    formRuleScope.value = rule.postScope || 'all';
    document.getElementById('form-rule-post-id').value = rule.postId || '';
    formPostIdGroup.style.display = formRuleScope.value === 'specific' ? 'block' : 'none';

    document.getElementById('form-rule-keywords').value = rule.keywords.join(', ');
    document.getElementById('form-rule-public-replies').value = (rule.publicReplies || []).join('\n');
    document.getElementById('form-rule-private-reply').value = rule.privateReply || '';
    document.getElementById('form-rule-active').checked = rule.isActive;

    document.getElementById('modal-title').textContent = 'تعديل قاعدة الرد';
    modal.style.display = 'flex';
  }

  function closeModal() {
    modal.style.display = 'none';
  }

  btnOpenCreate.addEventListener('click', openCreateRuleModal);
  if (btnQuickNewRule) btnQuickNewRule.addEventListener('click', openCreateRuleModal);
  btnCloseModal.addEventListener('click', closeModal);
  btnCancelModal.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') closeModal();
  });

  ruleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('form-rule-id').value;
    const name = document.getElementById('form-rule-name').value.trim();
    const platform = document.getElementById('form-rule-platform').value;
    const postScope = formRuleScope.value;
    const postId = document.getElementById('form-rule-post-id').value.trim();
    const keywordsRaw = document.getElementById('form-rule-keywords').value;
    const publicRepliesRaw = document.getElementById('form-rule-public-replies').value;
    const privateReply = document.getElementById('form-rule-private-reply').value.trim();
    const isActive = document.getElementById('form-rule-active').checked;

    const keywords = keywordsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const publicReplies = publicRepliesRaw.split('\n').map(s => s.trim()).filter(Boolean);

    const payload = {
      id: id || undefined,
      name,
      platform,
      postScope,
      postId: postScope === 'specific' ? postId : '',
      keywords,
      publicReplies: publicReplies.length > 0 ? publicReplies : ['تم الرد في الخاص 📩'],
      privateReply,
      isActive
    };

    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        closeModal();
        await fetchRules();
        fetchStats();
        const targetToSelect = (payload.postScope === 'specific' && payload.postId) ? payload.postId : 'all';
        updateSimulatorPostPicker(targetToSelect);
      }
    } catch (err) {
      alert('حدث خطأ في حفظ القاعدة: ' + err.message);
    }
  });

  // -------------------------------------------------------------
  // 9. السجلات وحفظ الإعدادات مع درع الأمان Anti-Ban
  // -------------------------------------------------------------
  document.getElementById('btn-refresh-logs').addEventListener('click', () => {
    fetchLogs();
  });

  document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    if (confirm('هل تود مسح جميع السجلات الحالية؟')) {
      await fetch('/api/logs', { method: 'DELETE' });
      fetchLogs();
      fetchStats();
    }
  });

  const btnSaveSettings = document.getElementById('btn-save-settings');
  const feedbackMsg = document.getElementById('save-settings-feedback');

  btnSaveSettings.addEventListener('click', async () => {
    const verifyToken = document.getElementById('setting-verify-token').value.trim();
    const pageId = document.getElementById('setting-page-id').value.trim();
    const instagramAccountId = document.getElementById('setting-ig-account-id').value.trim();
    const pageAccessToken = document.getElementById('setting-page-token').value.trim();
    const enableLiveGraphApi = document.getElementById('setting-live-toggle').checked;

    // تجميع إعدادات درع الأمان
    const maxPerHourEl = document.getElementById('antiban-max-per-hour');
    const enforce7DaysEl = document.getElementById('antiban-enforce-7days');
    const negativeFilterEl = document.getElementById('antiban-negative-filter');
    const negativeKeywordsEl = document.getElementById('antiban-negative-keywords');

    const antiBan = {
      enabled: document.getElementById('antiban-enabled').checked,
      emergencyStop: (appState.stats && appState.stats.emergencyStop) || false,
      minDelaySeconds: parseInt(document.getElementById('antiban-min-delay').value, 10) || 2,
      maxDelaySeconds: parseInt(document.getElementById('antiban-max-delay').value, 10) || 5,
      maxRepliesPerHour: maxPerHourEl ? (parseInt(maxPerHourEl.value, 10) || 150) : 150,
      enableUserCooldown: document.getElementById('antiban-user-cooldown').checked,
      userCooldownMinutes: 10,
      enableDeduplication: document.getElementById('antiban-deduplication').checked,
      enforce7DayPolicy: enforce7DaysEl ? enforce7DaysEl.checked : true,
      enableNegativeFilter: negativeFilterEl ? negativeFilterEl.checked : true,
      negativeKeywords: negativeKeywordsEl 
        ? negativeKeywordsEl.value.split(',').map(s => s.trim()).filter(Boolean)
        : ["نصابين", "سرقة", "حرامية", "غش", "اشتكي", "سيء", "شكوى", "نصاب", "كذابين"],
      autoBackoffOnLimit: document.getElementById('antiban-auto-backoff').checked
    };

    const appSecretEl = document.getElementById('setting-app-secret');
    const appSecret = appSecretEl ? appSecretEl.value.trim() : '';

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verifyToken,
          pageId,
          instagramAccountId,
          pageAccessToken,
          enableLiveGraphApi,
          antiBan,
          appSecret
        })
      });
      const data = await res.json();
      if (data.success) {
        feedbackMsg.textContent = '✅ تم حفظ جميع الإعدادات وتفعيل درع الأمان بنجاح!';
        fetchStats();
        setTimeout(() => { feedbackMsg.textContent = ''; }, 3500);
      }
    } catch (err) {
      alert('خطأ أثناء حفظ الإعدادات: ' + err.message);
    }
  });

  // حدث النقر على زر إيقاف الطوارئ اللحظي
  const btnEmergencyStop = document.getElementById('btn-emergency-stop');
  if (btnEmergencyStop) {
    btnEmergencyStop.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/emergency-stop/toggle', { method: 'POST' });
        const data = await res.json();
        fetchStats();
        fetchLogs();
      } catch (err) {
        alert('حدث خطأ في زر الطوارئ: ' + err.message);
      }
    });
  }

  document.getElementById('btn-copy-webhook').addEventListener('click', () => {
    const input = document.getElementById('webhook-url-input');
    navigator.clipboard.writeText(input.value);
    const btn = document.getElementById('btn-copy-webhook');
    btn.textContent = 'تم النسخ! ✓';
    setTimeout(() => { btn.textContent = 'نسخ الرابط'; }, 2000);
  });

  document.getElementById('btn-copy-token').addEventListener('click', () => {
    const input = document.getElementById('setting-verify-token');
    navigator.clipboard.writeText(input.value);
    const btn = document.getElementById('btn-copy-token');
    btn.textContent = 'تم النسخ! ✓';
    setTimeout(() => { btn.textContent = 'نسخ الرمز'; }, 2000);
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // -------------------------------------------------------------
  // 10. نظام القفل والمصادقة برمز PIN (Master PIN Security System)
  // -------------------------------------------------------------
  const pinLockModal = document.getElementById('pin-lock-modal');
  const pinCardIcon = document.getElementById('pin-card-icon');
  const pinCardTitle = document.getElementById('pin-card-title');
  const pinCardSubtitle = document.getElementById('pin-card-subtitle');
  const pinAuthForm = document.getElementById('pin-auth-form');
  const inputPinCode = document.getElementById('input-pin-code');
  const pinConfirmWrapper = document.getElementById('pin-confirm-wrapper');
  const inputPinConfirm = document.getElementById('input-pin-confirm');
  const pinFeedback = document.getElementById('pin-feedback');
  const btnPinSubmit = document.getElementById('btn-pin-submit');

  function showPinLockScreen(setup = false) {
    isSetupMode = setup;
    pinFeedback.textContent = '';
    pinFeedback.className = 'pin-feedback-msg';
    inputPinCode.value = '';
    inputPinConfirm.value = '';

    const btnCancelPin = document.getElementById('btn-cancel-pin-setup');
    if (setup) {
      pinCardIcon.textContent = '🔐';
      pinCardTitle.textContent = 'إنشاء رمز الحماية الأول';
      pinCardSubtitle.textContent = 'لحماية لوحة التحكم عند فتحها من الجوال أو الإنترنت، اختر رمز PIN (4 أرقام أو أحرف على الأقل)';
      pinConfirmWrapper.style.display = 'block';
      inputPinConfirm.required = true;
      btnPinSubmit.textContent = 'تفعيل الحماية وحفظ الرمز 🛡️';
      if (btnCancelPin) btnCancelPin.style.display = 'block';
    } else {
      pinCardIcon.textContent = '🔒';
      pinCardTitle.textContent = 'لوحة التحكم محمية';
      pinCardSubtitle.textContent = 'أدخل رمز الـ PIN المخصص لفتح اللوحة بأمان';
      pinConfirmWrapper.style.display = 'none';
      inputPinConfirm.required = false;
      btnPinSubmit.textContent = 'فتح اللوحة 🔓';
      if (btnCancelPin) btnCancelPin.style.display = 'none';
    }

    pinLockModal.style.display = 'flex';
    setTimeout(() => inputPinCode.focus(), 150);
  }

  function hidePinLockScreen() {
    pinLockModal.style.display = 'none';
  }

  const btnCancelPin = document.getElementById('btn-cancel-pin-setup');
  if (btnCancelPin) {
    btnCancelPin.addEventListener('click', () => {
      hidePinLockScreen();
      initializeData();
    });
  }

  if (pinAuthForm) {
    pinAuthForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = inputPinCode.value.trim();
      pinFeedback.textContent = '';
      pinFeedback.className = 'pin-feedback-msg';

      if (isSetupMode) {
        const confirmPin = inputPinConfirm.value.trim();
        if (pin.length < 4) {
          pinFeedback.textContent = 'رمز PIN يجب أن يتكون من 4 خانات على الأقل';
          pinFeedback.classList.add('error');
          return;
        }
        if (pin !== confirmPin) {
          pinFeedback.textContent = 'الرمزان غير متطابقين، يرجى إعادة التأكيد';
          pinFeedback.classList.add('error');
          return;
        }

        try {
          btnPinSubmit.disabled = true;
          btnPinSubmit.textContent = 'جاري التفعيل...';
          const res = await fetch('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
          });
          const data = await res.json();
          if (data.success && data.token) {
            localStorage.setItem('mp_auth_token', data.token);
            hidePinLockScreen();
            initializeData();
          } else {
            pinFeedback.textContent = data.message || data.error || 'فشل حفظ الرمز';
            pinFeedback.classList.add('error');
          }
        } catch (err) {
          pinFeedback.textContent = 'حدث خطأ: ' + err.message;
          pinFeedback.classList.add('error');
        } finally {
          btnPinSubmit.disabled = false;
          btnPinSubmit.textContent = 'تفعيل الحماية وحفظ الرمز 🛡️';
        }
      } else {
        // وضع الدخول بـ PIN
        try {
          btnPinSubmit.disabled = true;
          btnPinSubmit.textContent = 'جاري التحقق...';
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
          });
          const data = await res.json();
          if (data.success && data.token) {
            localStorage.setItem('mp_auth_token', data.token);
            hidePinLockScreen();
            initializeData();
          } else {
            pinFeedback.textContent = data.message || 'رمز PIN غير صحيح';
            pinFeedback.classList.add('error');
            inputPinCode.select();
          }
        } catch (err) {
          pinFeedback.textContent = 'حدث خطأ في الاتصال: ' + err.message;
          pinFeedback.classList.add('error');
        } finally {
          btnPinSubmit.disabled = false;
          btnPinSubmit.textContent = 'فتح اللوحة 🔓';
        }
      }
    });
  }

  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      
      const changePinBtn = document.getElementById('btn-change-pin-trigger');
      const lockNowBtn = document.getElementById('btn-lock-now');

      if (!data.isConfigured) {
        localStorage.removeItem('mp_auth_token');
        if (changePinBtn) changePinBtn.innerHTML = '🔐 تعيين رمز PIN لحماية اللوحة';
        if (lockNowBtn) lockNowBtn.style.display = 'none';
      } else {
        if (changePinBtn) changePinBtn.innerHTML = '🔑 تغيير رمز الـ PIN';
        if (lockNowBtn) lockNowBtn.style.display = 'inline-flex';
      }

      if (data.isConfigured && !data.isAuthenticated) {
        showPinLockScreen(false);
      } else {
        hidePinLockScreen();
        initializeData();
      }
    } catch (err) {
      console.error('فشل فحص حالة المصادقة:', err);
      initializeData();
    }
  }

  // -------------------------------------------------------------
  // 11. نظام التحديث المباشر السحابي (Live App Update Handshake)
  // -------------------------------------------------------------
  const updateToast = document.getElementById('update-toast');
  const btnApplyUpdate = document.getElementById('btn-apply-update');

  async function checkAppUpdates() {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return;
      const data = await res.json();
      if (data.version && data.version !== CLIENT_VERSION) {
        console.log(`🚀 يتوفر إصدار أحدث للتطبيق: ${data.version} (الحالي: ${CLIENT_VERSION})`);
        if (updateToast) updateToast.style.display = 'flex';
      }
    } catch (e) {
      // أخطاء صامتة
    }
  }

  if (btnApplyUpdate) {
    btnApplyUpdate.addEventListener('click', async () => {
      btnApplyUpdate.disabled = true;
      btnApplyUpdate.textContent = 'جاري التحديث...';
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ action: 'skipWaiting' });
      }
      setTimeout(() => {
        window.location.reload(true);
      }, 300);
    });
  }

  setInterval(checkAppUpdates, 30000);
  window.addEventListener('focus', checkAppUpdates);

  // -------------------------------------------------------------
  // 12. النسخ الاحتياطي وقفل اللوحة وتغيير الرمز (Backup & PIN)
  // -------------------------------------------------------------
  const btnExportBackup = document.getElementById('btn-export-backup');
  if (btnExportBackup) {
    btnExportBackup.addEventListener('click', async () => {
      try {
        btnExportBackup.textContent = 'جاري التصدير...';
        const res = await fetch('/api/backup');
        if (!res.ok) throw new Error('فشل التصدير من السيرفر');
        const blob = await res.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `metapulse-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
        btnExportBackup.textContent = 'تم التحميل بنجاح! ✓';
        setTimeout(() => { btnExportBackup.textContent = '💾 تحميل نسخة احتياطية (Backup)'; }, 2500);
      } catch (err) {
        alert('حدث خطأ أثناء تحميل النسخة: ' + err.message);
        btnExportBackup.textContent = '💾 تحميل نسخة احتياطية (Backup)';
      }
    });
  }

  const btnImportBackupTrigger = document.getElementById('btn-import-backup-trigger');
  const backupFileInput = document.getElementById('backup-file-input');
  if (btnImportBackupTrigger && backupFileInput) {
    btnImportBackupTrigger.addEventListener('click', () => {
      backupFileInput.click();
    });

    backupFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          if (!parsed.rules || !parsed.settings) {
            alert('الملف المحدد غير صالح أو لا يحتوي على بنية البيانات الصحيحة.');
            return;
          }
          if (confirm(`هل أنت متأكد من استعادة هذه النسخة الاحتياطية؟\nسيتم تحديث القواعد والإعدادات دون المساس بحسابك.`)) {
            const res = await fetch('/api/restore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(parsed)
            });
            const data = await res.json();
            if (data.success) {
              alert('✅ ' + data.message);
              initializeData();
            } else {
              alert('فشل استعادة النسخة: ' + (data.message || data.error));
            }
          }
        } catch (err) {
          alert('خطأ في قراءة ملف النسخة الاحتياطية: ' + err.message);
        } finally {
          backupFileInput.value = '';
        }
      };
      reader.readAsText(file);
    });
  }

  // قفل اللوحة يدوياً
  const btnLockNow = document.getElementById('btn-lock-now');
  if (btnLockNow) {
    btnLockNow.addEventListener('click', async () => {
      if (confirm('هل ترغب في قفل لوحة التحكم وتسجيل الخروج الآن؟')) {
        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        localStorage.removeItem('mp_auth_token');
        showPinLockScreen(false);
      }
    });
  }

  // تغيير رمز الـ PIN
  const changePinModal = document.getElementById('change-pin-modal');
  const btnChangePinTrigger = document.getElementById('btn-change-pin-trigger');
  const btnCloseChangePin = document.getElementById('btn-close-change-pin');
  const btnCancelChangePin = document.getElementById('btn-cancel-change-pin');
  const changePinForm = document.getElementById('change-pin-form');
  const changePinFeedback = document.getElementById('change-pin-feedback');

  if (btnChangePinTrigger && changePinModal) {
    btnChangePinTrigger.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        if (!data.isConfigured) {
          showPinLockScreen(true);
        } else {
          changePinFeedback.textContent = '';
          changePinForm.reset();
          changePinModal.style.display = 'flex';
        }
      } catch (e) {
        changePinModal.style.display = 'flex';
      }
    });

    const closeChangePinModal = () => { changePinModal.style.display = 'none'; };
    if (btnCloseChangePin) btnCloseChangePin.addEventListener('click', closeChangePinModal);
    if (btnCancelChangePin) btnCancelChangePin.addEventListener('click', closeChangePinModal);

    changePinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPin = document.getElementById('old-pin-input').value.trim();
      const newPin = document.getElementById('new-pin-input').value.trim();
      const confirmNewPin = document.getElementById('confirm-new-pin-input').value.trim();

      if (newPin !== confirmNewPin) {
        changePinFeedback.textContent = 'الرمزان الجديدان غير متطابقين';
        changePinFeedback.style.color = '#ef4444';
        return;
      }

      try {
        const res = await fetch('/api/auth/change-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPin, newPin })
        });
        const data = await res.json();
        if (data.success) {
          changePinFeedback.textContent = '✅ ' + data.message;
          changePinFeedback.style.color = '#10b981';
          setTimeout(() => {
            closeChangePinModal();
          }, 1500);
        } else {
          changePinFeedback.textContent = '⚠️ ' + (data.message || data.error);
          changePinFeedback.style.color = '#ef4444';
        }
      } catch (err) {
        changePinFeedback.textContent = 'حدث خطأ: ' + err.message;
        changePinFeedback.style.color = '#ef4444';
      }
    });
  }

  function initializeData() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    fetchStats();
    fetchRules();
    fetchLogs();
    fetchSettings();
  }

  // التهيئة المبدئية
  bindChipButtons();
  updateMockupPostContent();
  checkAuthStatus();
  checkAppUpdates();
});
