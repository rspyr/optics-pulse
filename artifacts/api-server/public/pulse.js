(function() {
  "use strict";

  var CONFIG = {
    clientId: "",
    endpointUrl: "",
    cookieDomain: "",
    cookieTTL: 30,
    excludeFields: [],
    captureFields: [],
    customDimensions: {},
    funnelSlug: ""
  };

  var scriptTag = document.currentScript
    || document.querySelector("script[src*='pulse.js'][data-client-id]")
    || document.querySelector("script[src*='pulse.js'][data-tenant]")
    || document.querySelector("script[src*='pulse.js']");

  var inlineConfig = window.__pulseConfig || window.__pulse_config || null;

  if (inlineConfig) {
    CONFIG.clientId = inlineConfig.clientId || inlineConfig.client_id || "";
    CONFIG.endpointUrl = inlineConfig.endpoint || inlineConfig.endpointUrl || "";
    CONFIG.cookieDomain = inlineConfig.cookieDomain || "";
    CONFIG.cookieTTL = inlineConfig.cookieTTL || 30;
    CONFIG.funnelSlug = inlineConfig.funnel || inlineConfig.funnelSlug || "";
    if (Array.isArray(inlineConfig.excludeFields)) CONFIG.excludeFields = inlineConfig.excludeFields;
    if (Array.isArray(inlineConfig.captureFields)) CONFIG.captureFields = inlineConfig.captureFields;
    if (inlineConfig.custom && typeof inlineConfig.custom === "object") CONFIG.customDimensions = inlineConfig.custom;
  }

  if (scriptTag) {
    if (!CONFIG.clientId) {
      CONFIG.clientId = scriptTag.getAttribute("data-client-id") || scriptTag.getAttribute("data-tenant") || "";
    }
    if (!CONFIG.endpointUrl) {
      CONFIG.endpointUrl = scriptTag.getAttribute("data-endpoint") || "";
    }
    if (!CONFIG.cookieDomain) {
      CONFIG.cookieDomain = scriptTag.getAttribute("data-cookie-domain") || "";
    }
    if (!CONFIG.funnelSlug) {
      CONFIG.funnelSlug = scriptTag.getAttribute("data-funnel") || "";
    }
    try {
      var rawExclude = scriptTag.getAttribute("data-exclude-fields");
      if (rawExclude && !CONFIG.excludeFields.length) CONFIG.excludeFields = JSON.parse(rawExclude);
    } catch(e) {}
    try {
      var rawCapture = scriptTag.getAttribute("data-capture-fields");
      if (rawCapture && !CONFIG.captureFields.length) CONFIG.captureFields = JSON.parse(rawCapture);
    } catch(e) {}
    try {
      var rawCustom = scriptTag.getAttribute("data-custom");
      if (rawCustom && !Object.keys(CONFIG.customDimensions).length) CONFIG.customDimensions = JSON.parse(rawCustom);
    } catch(e) {}
    if (!CONFIG.endpointUrl && scriptTag.src) {
      CONFIG.endpointUrl = scriptTag.src.replace(/\/(?:api\/)?pulse\.js.*$/, "") + "/api/collect/submit";
    }
  }

  var ATTR_COOKIE = "_attr_data";
  var LP_COOKIE = "_attr_lp";
  var QUEUE_KEY = "_attr_queue";
  var QUEUE_CAP = 10;
  var RETRY_LIMIT = 2;
  var RETRY_DELAY = 1500;
  var HEARTBEAT_INTERVAL = 6 * 60 * 60 * 1000;
  var SENSITIVE_FIELDS = ["password", "passwd", "credit_card", "creditcard", "card_number", "cardnumber", "cvv", "cvc", "ccv", "ssn", "social_security", "socialsecurity"];

  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var CLICK_ID_KEYS = ["gclid", "fbclid", "msclkid", "ttclid", "li_fat_id", "wbraid"];
  var ALL_ATTR_KEYS = UTM_KEYS.concat(CLICK_ID_KEYS);

  // Debug overlay state. Activated by ?pulse_debug=1 or window.__pulseDebug = true.
  var DEBUG = (function() {
    try {
      if (window.__pulseDebug === true) return true;
      var qs = (location.search || "");
      return qs.indexOf("pulse_debug=1") !== -1;
    } catch(e) { return false; }
  })();
  var debugLog = { bound: [], captured: [], rejected: [], heartbeat: "pending" };
  var debugRender = function() {};

  function debugRecordBound(form, source) {
    if (!DEBUG) return;
    var sel = describeForm(form);
    debugLog.bound.push({ selector: sel, source: source || "document", at: new Date().toISOString() });
    debugRender();
  }
  function debugRecordCaptured(formMeta, fieldNames, attribution) {
    if (!DEBUG) return;
    debugLog.captured.push({ meta: formMeta, fieldNames: fieldNames, attribution: attribution, at: new Date().toISOString() });
    debugRender();
  }
  function debugRecordRejected(reason, formMeta) {
    if (!DEBUG) return;
    debugLog.rejected.push({ reason: reason, meta: formMeta || null, at: new Date().toISOString() });
    debugRender();
  }
  function describeForm(form) {
    if (!form) return "(none)";
    try {
      var tag = (form.tagName || "node").toLowerCase();
      if (form.id) return tag + "#" + form.id;
      if (form.name) return tag + "[name=" + form.name + "]";
      var cls = form.className && typeof form.className === "string" ? "." + form.className.split(/\s+/).slice(0, 2).join(".") : "";
      return tag + cls;
    } catch(e) { return "(node)"; }
  }

  function getParam(name) {
    var m = location.search.match(new RegExp("[?&]" + name + "=([^&]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, days, domain) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    var cookie = name + "=" + encodeURIComponent(value) + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax";
    if (domain) cookie += ";domain=" + domain;
    document.cookie = cookie;
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getAttrData() {
    try {
      var raw = getCookie(ATTR_COOKIE);
      return raw ? JSON.parse(raw) : null;
    } catch(e) {
      return null;
    }
  }

  var hasUtm = false;
  var attrParams = {};
  for (var i = 0; i < ALL_ATTR_KEYS.length; i++) {
    var val = getParam(ALL_ATTR_KEYS[i]);
    if (val) {
      attrParams[ALL_ATTR_KEYS[i]] = val;
      hasUtm = true;
    }
  }

  if (hasUtm) {
    setCookie(ATTR_COOKIE, JSON.stringify(attrParams), CONFIG.cookieTTL, CONFIG.cookieDomain);
  }

  if (!getCookie(LP_COOKIE)) {
    setCookie(LP_COOKIE, location.href, CONFIG.cookieTTL, CONFIG.cookieDomain);
  }

  function getAttribution() {
    var stored = getAttrData() || {};
    return {
      utm_source: stored.utm_source || null,
      utm_medium: stored.utm_medium || null,
      utm_campaign: stored.utm_campaign || null,
      utm_term: stored.utm_term || null,
      utm_content: stored.utm_content || null,
      gclid: stored.gclid || null,
      fbclid: stored.fbclid || null,
      msclkid: stored.msclkid || null,
      ttclid: stored.ttclid || null,
      li_fat_id: stored.li_fat_id || null,
      wbraid: stored.wbraid || null
    };
  }

  function isSensitiveField(name) {
    if (!name) return false;
    var lower = name.toLowerCase().replace(/[\s-]/g, "_");
    for (var i = 0; i < SENSITIVE_FIELDS.length; i++) {
      if (lower === SENSITIVE_FIELDS[i] || lower.indexOf(SENSITIVE_FIELDS[i]) !== -1) return true;
    }
    return false;
  }

  function shouldCaptureField(name, type) {
    if (!name) return false;
    if (type === "password" || type === "hidden") return false;
    if (isSensitiveField(name)) return false;
    var lower = name.toLowerCase();
    for (var i = 0; i < CONFIG.excludeFields.length; i++) {
      if (lower === CONFIG.excludeFields[i].toLowerCase()) return false;
    }
    if (CONFIG.captureFields.length > 0) {
      for (var j = 0; j < CONFIG.captureFields.length; j++) {
        if (lower === CONFIG.captureFields[j].toLowerCase()) return true;
      }
      return false;
    }
    return true;
  }

  function extractFormFields(form) {
    var fields = {};
    try {
      var fd = new FormData(form);
      fd.forEach(function(value, key) {
        if (typeof value !== "string") return;
        var el = form.elements[key];
        var type = el ? (el.type || "").toLowerCase() : "";
        if (shouldCaptureField(key, type)) {
          fields[key] = value;
        }
      });
    } catch(e) {
      var elements = form.elements;
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        var name = el.name || el.id;
        var type = (el.type || "").toLowerCase();
        if (!name || !shouldCaptureField(name, type)) continue;
        if (el.tagName === "SELECT") {
          fields[name] = el.options[el.selectedIndex] ? el.options[el.selectedIndex].value : "";
        } else if (type === "checkbox") {
          fields[name] = el.checked ? (el.value || "on") : "";
        } else if (type === "radio") {
          if (el.checked) fields[name] = el.value;
        } else {
          fields[name] = el.value || "";
        }
      }
    }
    return fields;
  }

  // Walk inputs near a clicked button when there's no <form> wrapper.
  // Looks at sibling inputs within a common container (up to 6 ancestors).
  function extractFieldsNearButton(button) {
    var fields = {};
    var container = button;
    for (var depth = 0; depth < 6 && container; depth++) {
      var inputs = container.querySelectorAll
        ? container.querySelectorAll("input, textarea, select")
        : [];
      if (inputs.length > 0) {
        for (var i = 0; i < inputs.length; i++) {
          var el = inputs[i];
          var name = el.name || el.id || el.getAttribute("aria-label") || el.placeholder;
          var type = (el.type || "").toLowerCase();
          if (!name || !shouldCaptureField(name, type)) continue;
          var v;
          if (el.tagName === "SELECT") {
            v = el.options[el.selectedIndex] ? el.options[el.selectedIndex].value : "";
          } else if (type === "checkbox") {
            v = el.checked ? (el.value || "on") : "";
          } else if (type === "radio") {
            if (!el.checked) continue;
            v = el.value;
          } else {
            v = el.value || "";
          }
          if (v) fields[name] = v;
        }
        if (Object.keys(fields).length > 0) return fields;
      }
      container = container.parentElement;
    }
    return fields;
  }

  function buildPayload(fields, formMeta) {
    var customObj = {};
    for (var k in CONFIG.customDimensions) {
      if (CONFIG.customDimensions.hasOwnProperty(k)) customObj[k] = CONFIG.customDimensions[k];
    }
    if (CONFIG.funnelSlug) customObj.funnel = CONFIG.funnelSlug;
    return {
      client_id: CONFIG.clientId,
      submitted_at: new Date().toISOString(),
      page_url: location.href,
      landing_page: getCookie(LP_COOKIE) || location.href,
      referrer: document.referrer || "",
      attribution: getAttribution(),
      form: formMeta,
      fields: fields,
      custom: customObj
    };
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  function queuePayload(payload) {
    try {
      var raw = localStorage.getItem(QUEUE_KEY);
      var queue = raw ? JSON.parse(raw) : [];
      if (queue.length >= QUEUE_CAP) queue.shift();
      queue.push(payload);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch(e) {}
  }

  function sendPayload(payload) {
    var body = JSON.stringify(payload);

    var beaconOrQueue = function() {
      try {
        if (typeof navigator.sendBeacon === "function") {
          var sent = navigator.sendBeacon(CONFIG.endpointUrl, new Blob([body], { type: "application/json" }));
          if (sent) return;
        }
      } catch(e) {}
      queuePayload(payload);
    };

    var attempt = function(retries) {
      try {
        fetch(CONFIG.endpointUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true
        }).then(function(resp) {
          if (resp.ok) return;
          if (retries > 0) {
            sleep(RETRY_DELAY).then(function() { attempt(retries - 1); });
          } else {
            beaconOrQueue();
          }
        }).catch(function() {
          if (retries > 0) {
            sleep(RETRY_DELAY).then(function() { attempt(retries - 1); });
          } else {
            beaconOrQueue();
          }
        });
      } catch(e) {
        beaconOrQueue();
      }
    };

    attempt(RETRY_LIMIT);
  }

  function flushQueue() {
    try {
      var raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return;
      var queue = JSON.parse(raw);
      if (!queue.length) return;
      localStorage.removeItem(QUEUE_KEY);
      for (var i = 0; i < queue.length; i++) {
        sendPayload(queue[i]);
      }
    } catch(e) {}
  }

  flushQueue();

  var recentSubmits = [];
  var DEDUP_WINDOW = 3000;

  function isDuplicateSubmit(formMeta, fields) {
    var now = Date.now();
    // Include a hash of the field keys+values so two distinct submits in the same form aren't dedup'd,
    // but a single submit captured on multiple paths (capture-phase + bubble + framework event) is.
    var fieldSig = "";
    if (fields) {
      var keys = Object.keys(fields).sort();
      for (var i = 0; i < keys.length; i++) {
        fieldSig += keys[i] + "=" + (fields[keys[i]] || "") + "&";
      }
    }
    var key = (formMeta.type || "") + "|" + (formMeta.id || "") + "|" + (formMeta.name || "") + "|" + fieldSig;
    recentSubmits = recentSubmits.filter(function(entry) { return now - entry.ts < DEDUP_WINDOW; });
    for (var j = 0; j < recentSubmits.length; j++) {
      if (recentSubmits[j].key === key) return true;
    }
    recentSubmits.push({ key: key, ts: now });
    return false;
  }

  function handleFormSubmit(fields, formMeta) {
    if (isDuplicateSubmit(formMeta, fields)) {
      debugRecordRejected("duplicate (within " + DEDUP_WINDOW + "ms)", formMeta);
      return;
    }
    if (!fields || Object.keys(fields).length === 0) {
      debugRecordRejected("no capturable fields", formMeta);
      // Still send — backend may still get useful attribution context — but record rejection in debug.
    }
    var payload = buildPayload(fields, formMeta);
    debugRecordCaptured(formMeta, Object.keys(fields || {}), payload.attribution);
    sendPayload(payload);
  }

  var boundForms = typeof WeakSet !== "undefined" ? new WeakSet() : { _s: [], has: function(f) { return this._s.indexOf(f) !== -1; }, add: function(f) { this._s.push(f); } };

  function bindForm(form, source) {
    if (boundForms.has(form)) return;
    boundForms.add(form);
    debugRecordBound(form, source);

    // Per-form bubble-phase listener (legacy path; document-level capture-phase listener
    // below is the primary capture surface and wins over any in-page stopPropagation).
    form.addEventListener("submit", function() {
      captureFormSubmit(form);
    });
  }

  function captureFormSubmit(form) {
    if (!form || form.tagName !== "FORM") return;
    var fields = extractFormFields(form);
    var meta = {
      id: form.id || null,
      name: form.name || form.getAttribute("name") || null,
      type: "native",
      action: form.action || null
    };

    if (form.classList && form.classList.contains("wpforms-form")) {
      meta.type = "wpforms";
    } else if (form.closest && form.closest(".gform_wrapper")) {
      meta.type = "gravity";
    }

    handleFormSubmit(fields, meta);
  }

  // Capture-phase listener at document level. This fires before any in-page bubble-phase
  // listener has a chance to call stopPropagation. Crucial for Vite/React/Framer SPAs
  // whose form handlers swallow submit events.
  if (typeof document.addEventListener === "function") {
    document.addEventListener("submit", function(ev) {
      var form = ev.target;
      if (!form || form.tagName !== "FORM") return;
      // Mark as bound so per-form bubble listener (if added later) won't double-capture.
      if (!boundForms.has(form)) {
        boundForms.add(form);
        debugRecordBound(form, "capture-phase");
      }
      captureFormSubmit(form);
    }, true /* useCapture */);
  }

  // Click-time fallback for non-<form> submit buttons (React-style click-to-POST handlers
  // that never trigger a real form submit). We delay slightly so the page's own handler
  // gets the canonical input values first.
  function isSubmitLikeButton(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || (tag === "input" && (el.type === "submit" || el.type === "button"))) {
      // Skip if the button is inside a real <form> — the submit listener will handle it.
      if (el.closest && el.closest("form")) return false;
      var label = ((el.textContent || el.value || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
      var matchers = ["submit", "send", "reserve", "book", "claim", "get ", "request", "schedule", "sign up", "signup", "join", "start", "yes", "continue", "next", "apply", "register", "subscribe", "contact", "quote", "estimate", "free"];
      for (var i = 0; i < matchers.length; i++) {
        if (label.indexOf(matchers[i]) !== -1) return true;
      }
      // Buttons with type="submit" outside a form are clearly intended as submits.
      if (tag === "button" && (el.type === "submit" || !el.type)) return true;
    }
    return false;
  }

  if (typeof document.addEventListener === "function") {
    document.addEventListener("click", function(ev) {
      var el = ev.target;
      // Walk up a few levels in case the click target is a child element of the button
      // (e.g. a <span> inside a <button>).
      for (var depth = 0; depth < 4 && el; depth++) {
        if (isSubmitLikeButton(el)) {
          var fields = extractFieldsNearButton(el);
          if (Object.keys(fields).length === 0) {
            debugRecordRejected("button click but no nearby input values", { id: el.id || null, name: null, type: "button-fallback" });
            return;
          }
          handleFormSubmit(fields, {
            id: el.id || null,
            name: el.getAttribute("name") || null,
            type: "button-fallback",
            action: null
          });
          return;
        }
        el = el.parentElement;
      }
    }, true /* useCapture */);
  }

  function scanFormsInNode(root, source) {
    if (!root || !root.querySelectorAll) return;
    var forms = root.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) {
      bindForm(forms[i], source || "document");
    }
    // Open shadow roots (closed roots are inaccessible by design).
    try {
      var all = root.querySelectorAll("*");
      for (var j = 0; j < all.length; j++) {
        var node = all[j];
        if (node.shadowRoot) scanFormsInNode(node.shadowRoot, "shadow:" + describeForm(node));
      }
    } catch(e) {}
    // Same-origin iframes only (cross-origin throws SecurityError when accessing contentDocument).
    try {
      var frames = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
      for (var k = 0; k < frames.length; k++) {
        var frame = frames[k];
        var doc = null;
        try { doc = frame.contentDocument; } catch(e) { doc = null; }
        if (doc) {
          scanFormsInNode(doc, "iframe:" + (frame.src || frame.id || "(anon)"));
          // Bind a load listener so dynamically loaded same-origin iframes are scanned.
          if (!frame.__pulseFrameBound) {
            frame.__pulseFrameBound = true;
            try {
              frame.addEventListener("load", function() {
                try { if (this.contentDocument) scanFormsInNode(this.contentDocument, "iframe-loaded"); } catch(e) {}
              });
            } catch(e) {}
          }
        }
      }
    } catch(e) {}
  }

  function scanForms() {
    scanFormsInNode(document, "initial");
  }

  function startObserver() {
    if (typeof MutationObserver === "undefined") return;
    if (!document.body) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startObserver);
      } else {
        setTimeout(startObserver, 10);
      }
      return;
    }
    new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === "FORM") bindForm(node, "mutation");
          scanFormsInNode(node, "mutation");
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() {
      scanForms();
      startObserver();
    });
  } else {
    scanForms();
    startObserver();
  }

  window.addEventListener("message", function(event) {
    if (!event.data || typeof event.data !== "object") return;

    // HubSpot embedded form
    if (event.data.type === "hsFormCallback" && event.data.eventName === "onFormSubmitted") {
      var hsData = event.data.data || {};
      var fields = {};
      var submissionValues = hsData.submissionValues || {};
      for (var key in submissionValues) {
        if (submissionValues.hasOwnProperty(key) && shouldCaptureField(key, "text")) {
          fields[key] = submissionValues[key];
        }
      }
      handleFormSubmit(fields, {
        id: event.data.id || null,
        name: null,
        type: "hubspot",
        action: null
      });
      return;
    }

    // Typeform embed
    if (event.data.type === "form-submit") {
      handleFormSubmit({
        _typeform_response_id: event.data.responseId || null,
        _typeform_form_id: event.data.formId || null
      }, {
        id: event.data.formId || null,
        name: null,
        type: "typeform",
        action: null
      });
      return;
    }

    // GoHighLevel / LeadConnector embedded form widget.
    // GHL posts a message of shape { type: "form_submission", formId, fields } or
    // { event: "form_submitted", payload: {...} }. Cover both observed shapes.
    if (event.data.type === "form_submission" || event.data.type === "leadconnector_form_submitted" ||
        event.data.event === "form_submitted") {
      var ghlPayload = event.data.payload || event.data.data || event.data;
      var ghlFields = {};
      var src = ghlPayload && (ghlPayload.fields || ghlPayload.values || ghlPayload.formData) || {};
      for (var fk in src) {
        if (!src.hasOwnProperty(fk)) continue;
        var fv = src[fk];
        if (typeof fv === "string" && shouldCaptureField(fk, "text")) ghlFields[fk] = fv;
      }
      handleFormSubmit(ghlFields, {
        id: (ghlPayload && (ghlPayload.formId || ghlPayload.form_id)) || null,
        name: (ghlPayload && (ghlPayload.formName || ghlPayload.form_name)) || null,
        type: "leadconnector",
        action: null
      });
      return;
    }
  });

  if (typeof document.addEventListener === "function") {
    document.addEventListener("gform_confirmation_loaded", function(event) {
      var formId = event.detail ? event.detail.formId : null;
      var formEl = formId ? document.getElementById("gform_" + formId) : null;
      var fields = formEl ? extractFormFields(formEl) : {};
      handleFormSubmit(fields, {
        id: formId ? String(formId) : null,
        name: null,
        type: "gravity",
        action: null
      });
    });

    document.addEventListener("wpformsAjaxSubmitSuccess", function(event) {
      var formEl = event.target;
      if (!formEl || formEl.tagName !== "FORM") {
        formEl = event.detail ? event.detail.form : null;
      }
      var fields = formEl ? extractFormFields(formEl) : {};
      handleFormSubmit(fields, {
        id: formEl ? (formEl.id || null) : null,
        name: formEl ? (formEl.name || null) : null,
        type: "wpforms",
        action: null
      });
    });
  }

  function bindJQueryEvents() {
    if (typeof window.jQuery === "undefined") return;
    var $ = window.jQuery;
    try {
      $(document).on("gform_confirmation_loaded", function(event, formId) {
        var formEl = formId ? document.getElementById("gform_" + formId) : null;
        var fields = formEl ? extractFormFields(formEl) : {};
        handleFormSubmit(fields, {
          id: formId ? String(formId) : null,
          name: null,
          type: "gravity",
          action: null
        });
      });
      $(document).on("wpformsAjaxSubmitSuccess", function(event, response) {
        var formEl = null;
        if (response && response.length) formEl = response[0];
        if (!formEl || formEl.tagName !== "FORM") {
          formEl = event.target && event.target.tagName === "FORM" ? event.target : null;
        }
        var fields = formEl ? extractFormFields(formEl) : {};
        handleFormSubmit(fields, {
          id: formEl ? (formEl.id || null) : null,
          name: formEl ? (formEl.name || null) : null,
          type: "wpforms",
          action: null
        });
      });
    } catch(e) {}
  }

  if (typeof window.jQuery !== "undefined") {
    bindJQueryEvents();
  } else {
    var jqCheckCount = 0;
    var jqCheckInterval = setInterval(function() {
      jqCheckCount++;
      if (typeof window.jQuery !== "undefined") {
        clearInterval(jqCheckInterval);
        bindJQueryEvents();
      } else if (jqCheckCount > 20) {
        clearInterval(jqCheckInterval);
      }
    }, 500);
  }

  var apiBase = "";
  var inlineEndpoint = inlineConfig && (inlineConfig.endpoint || inlineConfig.endpointUrl || inlineConfig.endpoint_url) || "";
  if (inlineEndpoint) {
    apiBase = inlineEndpoint.replace(/\/api\/collect\/submit\/?$/, "");
  } else if (scriptTag && scriptTag.src) {
    apiBase = scriptTag.src.replace(/\/(?:api\/)?pulse\.js.*$/, "");
  }

  var tenantIdAttr = null;
  if (inlineConfig && inlineConfig.tenantId) {
    tenantIdAttr = String(inlineConfig.tenantId);
  } else if (scriptTag) {
    tenantIdAttr = scriptTag.getAttribute("data-tenant");
  }

  function sendHeartbeat() {
    if ((!tenantIdAttr && !CONFIG.clientId) || !apiBase) return;
    try {
      var payload = { domain: location.hostname, pageUrl: location.href };
      if (tenantIdAttr) payload.tenantId = parseInt(tenantIdAttr, 10);
      if (CONFIG.clientId) payload.clientId = CONFIG.clientId;
      var xhr = new XMLHttpRequest();
      xhr.open("POST", apiBase + "/api/collect/heartbeat", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          debugLog.heartbeat = xhr.status === 200 ? "ok (" + new Date().toISOString() + ")" : "error " + xhr.status;
          debugRender();
        }
      };
      xhr.send(JSON.stringify(payload));
    } catch(e) {
      debugLog.heartbeat = "exception: " + (e && e.message ? e.message : "unknown");
      debugRender();
    }
  }

  if (apiBase) {
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  }

  // ---- Debug overlay --------------------------------------------------------
  if (DEBUG) {
    var overlayEl = null;
    var setupOverlay = function() {
      if (overlayEl || !document.body) return;
      overlayEl = document.createElement("div");
      overlayEl.id = "__pulse_debug_overlay";
      overlayEl.setAttribute("style", [
        "position:fixed","right:8px","bottom:8px","z-index:2147483647",
        "max-width:380px","max-height:60vh","overflow:auto",
        "background:rgba(10,10,12,0.95)","color:#e6e6e6","font:11px/1.45 ui-monospace,Menlo,Consolas,monospace",
        "padding:10px 12px","border:1px solid #2a2a2e","border-radius:8px",
        "box-shadow:0 8px 32px rgba(0,0,0,0.5)"
      ].join(";"));
      document.body.appendChild(overlayEl);
    };
    debugRender = function() {
      setupOverlay();
      if (!overlayEl) return;
      var html = "";
      html += "<div style=\"font-weight:600;color:#a3e635;margin-bottom:4px\">pulse.js debug</div>";
      html += "<div>client: <b>" + (CONFIG.clientId || "(none)") + "</b> · endpoint: " + (CONFIG.endpointUrl || "(none)") + "</div>";
      html += "<div>heartbeat: " + debugLog.heartbeat + "</div>";
      html += "<div style=\"margin-top:6px\"><b>Bound (" + debugLog.bound.length + ")</b></div>";
      var bn = debugLog.bound.slice(-10);
      for (var i = 0; i < bn.length; i++) html += "<div>· " + bn[i].selector + " <span style=\"color:#888\">via " + bn[i].source + "</span></div>";
      html += "<div style=\"margin-top:6px\"><b style=\"color:#34d399\">Captured (" + debugLog.captured.length + ")</b></div>";
      var cn = debugLog.captured.slice(-10);
      for (var j = 0; j < cn.length; j++) {
        var c = cn[j];
        var attrPairs = [];
        for (var ak in c.attribution) { if (c.attribution[ak]) attrPairs.push(ak + "=" + c.attribution[ak]); }
        html += "<div>· [" + (c.meta && c.meta.type ? c.meta.type : "?") + "] fields: " + (c.fieldNames.join(",") || "(none)") +
                "<br><span style=\"color:#888\">attr: " + (attrPairs.join(", ") || "(none)") + "</span></div>";
      }
      html += "<div style=\"margin-top:6px\"><b style=\"color:#fbbf24\">Rejected (" + debugLog.rejected.length + ")</b></div>";
      var rn = debugLog.rejected.slice(-8);
      for (var k = 0; k < rn.length; k++) html += "<div>· " + rn[k].reason + "</div>";
      overlayEl.innerHTML = html;
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", debugRender);
    } else {
      debugRender();
    }
  }
})();
