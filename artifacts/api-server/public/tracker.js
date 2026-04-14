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
    || document.querySelector("script[src*='tracker.js'][data-client-id]")
    || document.querySelector("script[src*='tracker.js'][data-tenant]")
    || document.querySelector("script[src*='tracker.js']");

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
      CONFIG.endpointUrl = scriptTag.src.replace(/\/tracker\.js.*$/, "") + "/api/tracker/submit";
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

  function isDuplicateSubmit(formMeta) {
    var now = Date.now();
    var key = (formMeta.type || "") + "|" + (formMeta.id || "") + "|" + (formMeta.name || "");
    recentSubmits = recentSubmits.filter(function(entry) { return now - entry.ts < DEDUP_WINDOW; });
    for (var i = 0; i < recentSubmits.length; i++) {
      if (recentSubmits[i].key === key) return true;
    }
    recentSubmits.push({ key: key, ts: now });
    return false;
  }

  function handleFormSubmit(fields, formMeta) {
    if (isDuplicateSubmit(formMeta)) return;
    var payload = buildPayload(fields, formMeta);
    sendPayload(payload);
  }

  var boundForms = typeof WeakSet !== "undefined" ? new WeakSet() : { _s: [], has: function(f) { return this._s.indexOf(f) !== -1; }, add: function(f) { this._s.push(f); } };

  function bindForm(form) {
    if (boundForms.has(form)) return;
    boundForms.add(form);

    form.addEventListener("submit", function() {
      var fields = extractFormFields(form);
      var meta = {
        id: form.id || null,
        name: form.name || form.getAttribute("name") || null,
        type: "native",
        action: form.action || null
      };

      if (form.classList.contains("wpforms-form")) {
        meta.type = "wpforms";
      } else if (form.closest && form.closest(".gform_wrapper")) {
        meta.type = "gravity";
      }

      handleFormSubmit(fields, meta);
    });
  }

  function scanFormsInNode(root) {
    if (!root || !root.querySelectorAll) return;
    var forms = root.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) {
      bindForm(forms[i]);
    }
  }

  function scanForms() {
    scanFormsInNode(document);
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
          if (node.tagName === "FORM") bindForm(node);
          scanFormsInNode(node);
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
    apiBase = inlineEndpoint.replace(/\/api\/tracker\/submit\/?$/, "");
  } else if (scriptTag && scriptTag.src) {
    apiBase = scriptTag.src.replace(/\/tracker\.js.*$/, "");
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
      var payload = { domain: location.hostname };
      if (tenantIdAttr) payload.tenantId = parseInt(tenantIdAttr, 10);
      if (CONFIG.clientId) payload.clientId = CONFIG.clientId;
      var xhr = new XMLHttpRequest();
      xhr.open("POST", apiBase + "/api/tracker/heartbeat", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify(payload));
    } catch(e) {}
  }

  if (apiBase) {
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  }
})();
