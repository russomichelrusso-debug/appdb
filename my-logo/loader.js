// Shared Cortag loader timeline. Each device page calls this and registers the result inline,
// because the HyperFrames lint looks for the window.__timelines registration in the HTML itself.
window.buildCortagLoader = function () {
  const tl = gsap.timeline({ paused: true });

  // 0.0–0.7: blade sweeps left→right across the wordmark, uncovering it behind itself.
  // xPercent is relative to the blade's own width, so the sweep scales with the canvas.
  tl.fromTo(
    "#blade",
    { xPercent: 50, skewX: -16 },
    { xPercent: 717, skewX: -16, duration: 0.7, ease: "power3.inOut" },
    0,
  );
  tl.fromTo(
    "#logo",
    { clipPath: "inset(0 100% 0 0)" },
    { clipPath: "inset(0 0% 0 0)", duration: 0.7, ease: "power3.inOut" },
    0,
  );
  tl.to("#blade", { opacity: 0, duration: 0.15 }, 0.6);

  // 0.6–1.1: small settle so the logo lands with weight.
  tl.fromTo("#logo-wrap", { scale: 1.06 }, { scale: 1, duration: 0.5, ease: "power2.out" }, 0.6);

  // 0.8–3.2: loader appears and fills.
  tl.fromTo("#loader", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0.8);
  tl.fromTo("#fill", { scaleX: 0 }, { scaleX: 1, duration: 2.2, ease: "power1.inOut" }, 1.0);

  // 3.4–3.9: everything fades back to the white ground so the clip loops seamlessly.
  tl.to(["#logo-wrap", "#loader"], { opacity: 0, duration: 0.5, ease: "power2.in" }, 3.4);

  return tl;
};
