/* Adaptador: as páginas foram feitas para o "banco" do claude.ai (window.claude.use("db"/"user")).
   Versão de emergência: o mesmo contrato grava e lê numa planilha Google, sem login.
   Segurança (Fabio, 21/10: "nenhuma resposta pode se perder"):
   - cada resposta tenta gravar 3 vezes; só aparece "Salvo" quando o servidor confirma;
   - se a internet falhar, a resposta fica numa fila no aparelho e é reenviada sozinha
     (a cada 20 s, quando a internet volta e sempre que a página abre de novo). */
(function () {
  if (window.claude) return;
  var API = "https://script.google.com/macros/s/AKfycbx6O4OT3aWqiw2puVhVqaC8PmUORgBwvLxg3ukdiJWg5HUKNMn4RKHaztvUzQf_F6zBCg/exec";
  var page = location.pathname.replace(/index\.html$/, "").replace(/^.*(\/p\/)/, "$1");
  if (page.slice(-1) !== "/") page += "/";
  function enviaApi(acao, corpo) {
    return fetch(API, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ acao: acao }, corpo)), redirect: "follow" });
  }
  var OUTBOX = "lct_outbox";
  var uid = null;
  try { uid = localStorage.getItem("lct_uid"); } catch (e) {}
  if (!uid) {
    uid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(performance.now());
    try { localStorage.setItem("lct_uid", uid); } catch (e) {}
  }
  function readBox() { try { return JSON.parse(localStorage.getItem(OUTBOX) || "{}"); } catch (e) { return {}; } }
  function writeBox(box) { try { localStorage.setItem(OUTBOX, JSON.stringify(box)); } catch (e) {} }
  function post(item) {
    return enviaApi("r", item)
      .then(function (r) { if (!r.ok) throw new Error("save " + r.status); return r.json(); })
      .then(function (j) { if (!j || !j.ok) throw new Error("save not ok"); });
  }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function postRetry(item, tries) {
    return post(item).catch(function (e) {
      if (tries <= 1) throw e;
      return wait(1500).then(function () { return postRetry(item, tries - 1); });
    });
  }
  function key(item) { return item.page + "|" + item.col + "|" + item.id; }
  var flushing = false;
  function flush() {
    if (flushing) return;
    var box = readBox(), keys = Object.keys(box);
    if (!keys.length) return;
    flushing = true;
    keys.reduce(function (p, k) {
      return p.then(function () {
        return post(box[k]).then(function () {
          var now = readBox();
          if (now[k] && now[k].data.at === box[k].data.at) { delete now[k]; writeBox(now); }
        }).catch(function () {});
      });
    }, Promise.resolve()).then(function () { flushing = false; });
  }
  // avisa a equipe: página aberta e envio pelo WhatsApp (não interfere em nada se falhar)
  function evento(tipo) {
    try { if (localStorage.getItem("lct_equipe") === "1") return; } catch (e) {}  // aparelho da equipe não gera aviso
    enviaApi("v", { page: page, tipo: tipo, uid: uid }).catch(function () {});
  }
  evento("abriu");
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href*="wa.me"]') : null;
    if (a) evento("enviou");
  }, true);


  // ---- "Pedir ajuste" (Fabio, 21/10): o pedido NUNCA pode ficar só na tela
  // a página só gravava o ajuste quando a cliente clicava em "salvar"; aqui grava ao escolher, ao sair do campo e ao concluir.
  function campo(id, art) {   // planejamento: nota-<id> (texto) / anota-<id> (arte); página de artes: n-<id>
    return document.getElementById((art ? "anota-" : "nota-") + id) || (art ? null : document.getElementById("n-" + id));
  }
  function salvaAjuste(id, art) {
    var f = art ? window.decideArt : window.decide;
    if (typeof f !== "function") return;
    var t = campo(id, art);
    try { f(id, "ajuste", t ? t.value.trim() : ""); } catch (e) {}
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-act="ajuste"],[data-art="ajuste"]') : null;
    if (!b) return;
    var id = b.dataset.id, art = !!b.dataset.art;
    setTimeout(function () {
      salvaAjuste(id, art);
      var t = campo(id, art); if (t) t.focus();
    }, 0);
  });
  document.addEventListener("focusout", function (e) {
    var t = e.target; if (!t || !t.id) return;
    var m = t.id.match(/^(anota|nota|n)-(.+)$/); if (!m) return;
    salvaAjuste(m[2], m[1] === "anota");
  });
  function salvaTodosAjustes() {
    [].slice.call(document.querySelectorAll('[data-act="ajuste"][aria-pressed="true"],[data-art="ajuste"][aria-pressed="true"]')).forEach(function (b) {
      salvaAjuste(b.dataset.id, !!b.dataset.art);
    });
  }

  // ---- botão "Concluir" (Fabio, 21/10): avisa a equipe e grava uma cópia completa no servidor
  var PEND = "lct_concluir_" + page;
  function totais() {
    // contador da página ("X de N"); se não houver, conta os posts com botões na tela
    var el = document.getElementById("barText"), m = el ? (el.textContent || "").match(/(\d+)\s*de\s*(\d+)/) : null;
    if (m && +m[2] > 0) return { feitos: +m[1], total: +m[2] };
    var arts = [].slice.call(document.querySelectorAll("article")).filter(function (a) { return a.querySelector("[data-act]"); });
    return { feitos: arts.filter(function (a) { return a.querySelector('[data-act][aria-pressed="true"]'); }).length, total: arts.length };
  }
  function envia(total) {
    return postConcluir({ page: page, uid: uid, total: total }, 3);
  }
  function postConcluir(body, tries) {
    return enviaApi("concluir", body)
      .then(function (r) { if (!r.ok) throw new Error("concluir " + r.status); return r.json(); })
      .catch(function (e) { if (tries <= 1) throw e; return wait(1500).then(function () { return postConcluir(body, tries - 1); }); });
  }
  function aviso(txt, ok) {
    var d = document.getElementById("lct-aviso");
    if (!d) {
      d = document.createElement("div"); d.id = "lct-aviso"; d.setAttribute("role", "status");
      d.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:9999;max-width:min(92vw,520px);padding:14px 18px;border-radius:14px;font:600 15px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.18);text-align:center";
      document.body.appendChild(d);
    }
    d.style.background = ok ? "#1E7A4C" : "#A86A00"; d.style.color = "#fff"; d.textContent = txt;
    clearTimeout(d._t); d._t = setTimeout(function () { d.remove(); }, 9000);
  }
  function filaVazia() { var b = readBox(); return !Object.keys(b).some(function (k) { return b[k].page === page; }); }
  function pendente() {
    var p = null; try { p = JSON.parse(localStorage.getItem(PEND) || "null"); } catch (e) {}
    if (!p || !filaVazia()) return;
    envia(p.total).then(function () { try { localStorage.removeItem(PEND); } catch (e) {} }).catch(function () {});
  }
  setInterval(pendente, 20000); setTimeout(pendente, 3000);
  function montaBotao() {
    var wa = document.getElementById("wa");
    if (!wa || document.getElementById("lct-concluir")) return;
    var b = document.createElement("button");
    b.id = "lct-concluir"; b.type = "button"; b.className = "wa";
    b.style.cssText = "background:#1E7A4C;color:#fff;border:0;cursor:pointer;font-family:inherit";
    var ja = null; try { ja = localStorage.getItem("lct_concluido_" + page); } catch (e) {}
    b.textContent = ja ? "✓ Respostas enviadas · enviar de novo" : "✅ Concluir e enviar respostas";
    wa.parentNode.insertBefore(b, wa);
    // porcentagem + "Clique em Concluir" a 100% (Fabio, 21/10); o botão fica sempre visível
    var bt = document.getElementById("barText"), pct = document.createElement("b"), msg = document.createElement("span");
    pct.id = "lct-pct"; pct.style.cssText = "margin-left:8px;font-size:15px";
    msg.id = "lct-msg"; msg.style.cssText = "display:block;font-size:13px;font-weight:700;color:#1E7A4C;margin-top:2px";
    if (bt) { bt.parentNode.insertBefore(pct, bt.nextSibling); bt.parentNode.insertBefore(msg, pct.nextSibling); }
    var atualiza = function () {
      var t = totais(), v = t.total ? Math.round(t.feitos / t.total * 100) : 0;
      pct.textContent = t.total ? v + "%" : "";
      msg.textContent = t.total && t.feitos >= t.total ? "Tudo respondido! Clique em Concluir para finalizar ✅" : "";
      b.style.boxShadow = t.total && t.feitos >= t.total ? "0 0 0 4px rgba(30,122,76,.25)" : "none";
    };
    atualiza(); setInterval(atualiza, 800);
    b.addEventListener("click", function () {
      var t = totais();
      if (!t.total) return aviso("Aguarde a página carregar todos os posts e tente de novo.", false);  // nunca conclui sem saber o total
      if (t.feitos < t.total) {
        var falta = t.total - t.feitos;
        aviso("Não é possível concluir. Falta" + (falta > 1 ? "m " + falta + " posts" : " 1 post") + " para finalizar: escolha Aprovar, Pedir ajuste ou Recusar.", false);
        var alvo = [].slice.call(document.querySelectorAll("article")).filter(function (a) {
          return a.querySelector("[data-act]") && !a.querySelector('[data-act][aria-pressed="true"]');
        })[0];
        if (alvo) alvo.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      b.disabled = true; b.textContent = "Enviando…";
      salvaTodosAjustes();
      flush();
      var inicio = Date.now();
      (function espera() {
        if (!filaVazia() && Date.now() - inicio < 15000) { flush(); return setTimeout(espera, 1500); }
        if (!filaVazia()) {
          try { localStorage.setItem(PEND, JSON.stringify({ total: t.total })); } catch (e) {}
          b.disabled = false; b.textContent = "✅ Concluir e enviar respostas";
          return aviso("Sem internet agora. Suas respostas estão guardadas neste aparelho e serão enviadas sozinhas quando a internet voltar.", false);
        }
        envia(t.total).then(function (j) {
          var m = j && j.resumo ? String(j.resumo).match(/^(\d+) de/) : null;
          if (m && +m[1] < t.feitos) throw new Error("servidor com menos respostas");
          try { localStorage.setItem("lct_concluido_" + page, new Date().toISOString()); localStorage.removeItem(PEND); } catch (e) {}
          b.disabled = false; b.textContent = "✓ Respostas enviadas · enviar de novo";
          aviso("✅ Pronto! Suas respostas foram enviadas para a nossa equipe. Obrigado!", true);
        }).catch(function () {
          try { localStorage.setItem(PEND, JSON.stringify({ total: t.total })); } catch (e) {}
          b.disabled = false; b.textContent = "✅ Concluir e enviar respostas";
          aviso("Não conseguimos enviar agora. Suas respostas estão guardadas e vamos tentar de novo sozinhos.", false);
        });
      })();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", montaBotao); else montaBotao();

  setInterval(flush, 20000);
  window.addEventListener("online", flush);
  setTimeout(flush, 1000);
  function col(name) {
    return {
      doc: function (id) {
        return { set: function (data) {
          var item = { page: page, col: name, id: String(id), data: data };
          var box = readBox(); box[key(item)] = item; writeBox(box);   // guarda antes de enviar
          return postRetry(item, 3).then(function () {
            var now = readBox();
            if (now[key(item)] && JSON.stringify(now[key(item)].data) === JSON.stringify(data)) { delete now[key(item)]; writeBox(now); }
          });
        } };
      },
      onSnapshot: function (cb) {
        var stop = false;
        function load() {
          fetch(API + "?page=" + encodeURIComponent(page) + "&col=" + name, { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (rows) {
              if (stop) return;
              // respostas ainda na fila deste aparelho valem sobre as do servidor
              var box = readBox(), byId = {};
              rows.forEach(function (x) { byId[x.id] = x; });
              Object.keys(box).forEach(function (k) { var it = box[k]; if (it.page === page && it.col === name) byId[it.id] = { id: it.id, data: it.data }; });
              cb({ docs: Object.keys(byId).map(function (i) { var x = byId[i]; return { id: x.id, data: function () { return x.data; } }; }) });
            })
            .catch(function () {});
        }
        load();
        var t = setInterval(load, 30000);
        return function () { stop = true; clearInterval(t); };
      },
    };
  }
  var db = { collection: col };
  var user = { id: async function () { return uid; } };
  window.claude = { use: async function (n) { return n === "db" ? db : n === "user" ? user : null; } };
})();
