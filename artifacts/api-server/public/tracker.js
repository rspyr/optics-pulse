(function() {
  "use strict";
  var COOKIE_NAME = "_mos_gclid";
  var COOKIE_TTL = 90;
  var LS_KEY = "_mos_utm";
  var HEARTBEAT_INTERVAL = 6 * 60 * 60 * 1000;

  var scriptTag = document.currentScript;
  var tenantId = scriptTag ? scriptTag.getAttribute("data-tenant") : null;
  var apiBase = scriptTag ? scriptTag.src.replace(/\/tracker\.js.*$/, "") : "";

  function getParam(name) {
    var m = location.search.match(new RegExp("[?&]" + name + "=([^&]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = name + "=" + encodeURIComponent(value) + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax";
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  var gclid = getParam("gclid");
  var wbraid = getParam("wbraid");
  var utmSource = getParam("utm_source");
  var utmMedium = getParam("utm_medium");
  var utmCampaign = getParam("utm_campaign");

  if (gclid) {
    setCookie(COOKIE_NAME, gclid, COOKIE_TTL);
  }

  var LS_TTL_MS = COOKIE_TTL * 86400000;

  function purgeStaleStorage() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() < Date.now()) {
        localStorage.removeItem(LS_KEY);
        return null;
      }
      return parsed;
    } catch(e) {
      return null;
    }
  }

  purgeStaleStorage();

  var utmData = {
    gclid: gclid || getCookie(COOKIE_NAME) || null,
    wbraid: wbraid || null,
    utmSource: utmSource,
    utmMedium: utmMedium,
    utmCampaign: utmCampaign,
    landingPage: location.href,
    timestamp: new Date().toISOString(),
    expiresAt: new Date(Date.now() + LS_TTL_MS).toISOString()
  };

  try {
    localStorage.setItem(LS_KEY, JSON.stringify(utmData));
  } catch(e) {}

  function injectHiddenFields(form) {
    if (form.dataset.mosInjected) return;
    form.dataset.mosInjected = "1";
    var stored = purgeStaleStorage() || {};
    var fields = ["gclid", "wbraid", "utmSource", "utmMedium", "utmCampaign", "landingPage"];
    fields.forEach(function(f) {
      if (stored[f]) {
        var input = document.createElement("input");
        input.type = "hidden";
        input.name = "_mos_" + f;
        input.value = stored[f];
        form.appendChild(input);
      }
    });
  }

  function scanFormsInNode(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("form").forEach(injectHiddenFields);

    try {
      root.querySelectorAll("*").forEach(function(el) {
        if (el.shadowRoot) {
          scanFormsInNode(el.shadowRoot);
        }
      });
    } catch(e) {}
  }

  function scanForms() {
    scanFormsInNode(document);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanForms);
  } else {
    scanForms();
  }

  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node.nodeType === 1) {
            if (node.tagName === "FORM") injectHiddenFields(node);
            scanFormsInNode(node);

            if (node.shadowRoot) {
              scanFormsInNode(node.shadowRoot);
              new MutationObserver(function(shadowMutations) {
                shadowMutations.forEach(function(sm) {
                  sm.addedNodes.forEach(function(sn) {
                    if (sn.nodeType === 1) scanFormsInNode(sn);
                  });
                });
              }).observe(node.shadowRoot, { childList: true, subtree: true });
            }
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  function sendHeartbeat() {
    if (!tenantId || !apiBase) return;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", apiBase + "/api/tracker/heartbeat", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify({
        tenantId: parseInt(tenantId, 10),
        domain: location.hostname
      }));
    } catch(e) {}
  }

  if (tenantId && apiBase) {
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  }
})();
