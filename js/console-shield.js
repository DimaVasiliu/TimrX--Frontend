/* TimrX console guard — anti-tamper / self-XSS warning shown on every page. */
(function () {
  try {
    var stop = 'color:#e24b4a;font-size:42px;font-weight:800;line-height:1.2';
    var head = 'color:#f4f1ea;font-size:15px;font-weight:700;line-height:1.6';
    var body = 'color:#a39b8f;font-size:13px;line-height:1.6';
    console.log('%c⛔  STOP', stop);
    console.log('%cThis console is intended for developers only.', head);
    console.log(
      '%cDo NOT paste or run any code here. Tampering with TimrX, your account, or other users — or running code that someone sent you — is unauthorized, may be unlawful, and is a well-known scam ("self-XSS"). If someone told you to paste something into this window, close this tab.',
      body
    );
  } catch (e) {}
})();
