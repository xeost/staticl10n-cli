// Archivo: translations.js — generado automáticamente por staticl10n
// NO editar manualmente. Generado el: 2026-06-15T15:46:39.163Z
(function() {
  'use strict';

  var F = {"f1":"Tailwind es respaldado por increíbles socios y patrocinadores que permiten a un equipo de diseñadores e ingenieros talentosos mantener el framework a tiempo completo.","f2":"Tailwind es decididamente moderno, y aprovecha todas las características más recientes e impresionantes de CSS para hacer que la experiencia del desarrollador sea lo más agradable posible.","f3":"Bueno, no está exactamente a la vanguardia, pero simplemente anteponle un tamaño de pantalla a cualquier utilidad para aplicarlo en un punto de quiebre específico.","f4":"¿Qué sitio web hoy en día sin unos cuantos desenfoques de fondo? Sigue apilando filtros hasta que tu diseñador te pida, por favor, detente.","f5":"La paleta de colores ahora utiliza colores de amplio espectro más vibrantes sin que tengas que entender lo que significa nada de esto.","f6":"Transiciones que funcionan como lo esperarías — aplica unas pocas utilidades a un elemento y ya estás.","f7":"No tienes que recordar esa complicada sintaxis de gradiente; crea degradados increíblemente suaves con solo unas pocas clases utilitarias.","f8":"Nuestro motor de renderizado de próxima generación proporciona una velocidad y eficiencia inigualables, capacitando a los creadores para superar límites como nunca antes.","f9":"A veces dos dimensiones no son suficientes. Escala, rota y traslada cualquier elemento en un espacio tridimensional para añadir un toque de profundidad.","f10":"Tailwind elimina automáticamente todo el CSS no utilizado al compilar para producción, lo que significa que tu paquete CSS final será tan pequeño como puede serlo. De hecho, la mayoría de los proyectos de Tailwind envían menos de 10 kB de CSS al cliente.","f11":"Debido a que Tailwind es tan de bajo nivel, nunca te anima a diseñar el mismo sitio dos veces. Algunos de tus sitios favoritos están construidos con Tailwind, y probablemente no lo supieras.","f12":"Tailwind Plus es una colección de componentes de interfaz de usuario hermosos y totalmente responsivos, diseñados y desarrollados por nosotros, los creadores de Tailwind CSS. Cuenta con cientos de ejemplos listos para usar entre los que elegir, y está garantizado que le ayudará a encontrar el punto de partida perfecto para lo que desea construir."};

  var A = {"RSS 2.0":"RSS 2.0","Atom 1.0":"Átomo 1.0","JSON Feed":"Alimento JSON","Home":"Inicio","Select version of library":"Seleccionar versión de la biblioteca","GitHub repository":"Repositorio de GitHub","Search":"Búsqueda","Navigation":"Navegación","v0 logo":"logo v0","Kiro logo":"Logo Kiro","TipTap logo":"Logo de TipTap","Base UI logo":"Logo de interfaz base","CodeRabbit logo":"logotipo de CodeRabbit","Cursor logo":"Logo de Cursor","Webflow logo":"Logotipo de Webflow","Resend logo":"Volver a enviar logotipo","ImageKit logo":"Logo de ImageKit","Clerk logo":"Logotipo del empleado","Mintlify logo":"Logotipo de Mintlify","Mux logo":"Logo de Mux","Nutrient logo":"Logotipo de nutrientes","Lovable logo":"Logo adorable","Bolt logo":"Logotipo de Bolt","Fin logo":"Logo de Fin","Supabase logo":"Logotipo de Supabase","Shopify logo":"Logo de Shopify","Syntax logo":"Logotipo de sintaxis","Google AI Studio logo":"Logotipo de Google AI Studio","Vercel logo":"Logotipo de Vercel","Profound logo":"Logo profundo","Namespace logo":"Espacio de nombres logotipo","Postmark logo":"Logo de Postmark","Unblocked logo":"Logo desbloqueado","Momentic logo":"Logo Momentic","Graphite logo":"Logotipo de grafito","Greptile logo":"Logotipo de Greptile","Sanity logo":"Logotipo de Sanity","Railway logo":"Logotipo de ferrocarril","SerpApi logo":"Logotipo de SerpApi","Browserbase logo":"Logotipo de Browserbase","Polar logo":"Logotipo de Polar","Braintrust logo":"Logotipo de Braintrust","PostHog logo":"Logotipo de PostHog","Auth0 logo":"Logo de Auth0","Drag to resize":"Arrastrar para redimensionar","panel, HTML editor, animated":"panel, editor de HTML, animado","Tab Bar":"Barra de pestañas","editor, readonly, html file":"editor, solo lectura, archivo html","panel, terminal, animated":"panel, terminal, animado","panel, built CSS, animated":"Panel, construido con CSS, animado","editor, readonly, built CSS":"editor, de solo lectura, con CSS incorporado","OpenAI":"OpenAI","Opal":"Ópalo","Feastables":"Golosinas de fiesta","Gumroad":"Gumroad","Skims":"Skims","Reddit":"Reddit","Rivian":"Rivian","Shopify":"Shopify","Clerk":"Empleado","The Verge":"The Verge","Google IO":"Google IO","TED Talks":"Charlas de TED","Poolside":"Al lado de la piscina","Midjourney":"Midjourney","NASA/JPL":"NASA/JPL","System theme":"Tema del sistema","Light theme":"Tema claro","Dark theme":"Tema oscuro"};

  // Cached {el, id} pairs captured before React removes data-sl-id during hydration.
  // applyAll() uses these direct DOM references so it works even after the attribute is gone.
  var entries = [];
  var revealed = false;

  function translateAttributes(el) {
    ['alt', 'title', 'placeholder', 'aria-label', 'aria-description'].forEach(function(attr) {
      var val = el.getAttribute(attr);
      if (val && A[val.trim()] !== undefined) {
        el.setAttribute(attr, A[val.trim()]);
      }
    });
  }

  function walk(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    var tag = node.tagName && node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    if (node.hasAttribute('data-sl-id')) {
      var id = node.getAttribute('data-sl-id');
      if (F[id] !== undefined) node.innerHTML = F[id];
      node.querySelectorAll('[alt],[title],[placeholder],[aria-label],[aria-description]').forEach(translateAttributes);
      return;
    }
    translateAttributes(node);
    node.childNodes.forEach(walk);
  }

  // Re-applies all cached translations using stored element references.
  // Disconnects the observer first to prevent infinite mutation loops.
  function applyAll() {
    observer.disconnect();
    entries.forEach(function(e) {
      if (e.el.isConnected) e.el.innerHTML = F[e.id];
    });
    document.querySelectorAll('[alt],[title],[placeholder],[aria-label],[aria-description]').forEach(translateAttributes);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    document.body.style.opacity = '1';
    var hideEl = document.getElementById('staticl10n-hide');
    if (hideEl) hideEl.remove();
  }

  function init() {
    walk(document.body);

    // Cache element references NOW, before React hydration removes data-sl-id attributes.
    document.querySelectorAll('[data-sl-id]').forEach(function(el) {
      var id = el.getAttribute('data-sl-id');
      if (id && F[id] !== undefined) entries.push({ el: el, id: id });
    });

    // Wait for React hydration to finish (browser idle), then re-apply and reveal.
    // The timeout is a fallback: requestIdleCallback won't fire until React's tasks complete.
    function afterHydration() {
      applyAll();
      reveal();
    }
    if (window.requestIdleCallback) {
      requestIdleCallback(afterHydration, { timeout: 2500 });
    } else {
      setTimeout(afterHydration, 1200);
    }
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  // Absolute safety net: reveal even if requestIdleCallback never fires.
  setTimeout(reveal, 5000);

  // After initial hydration, watch for React re-renders that overwrite translations.
  // If any of our tracked elements (or their children) are mutated, re-apply.
  var observer = new MutationObserver(function(mutations) {
    var needsUpdate = false;
    for (var i = 0; i < mutations.length && !needsUpdate; i++) {
      var t = mutations[i].target;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].el === t || (entries[j].el.contains && entries[j].el.contains(t))) {
          needsUpdate = true;
          break;
        }
      }
    }
    if (needsUpdate) {
      applyAll();
    } else {
      for (var i = 0; i < mutations.length; i++) {
        mutations[i].addedNodes.forEach(function(n) {
          if (n.nodeType === Node.ELEMENT_NODE) walk(n);
        });
      }
    }
  });

  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

})();
