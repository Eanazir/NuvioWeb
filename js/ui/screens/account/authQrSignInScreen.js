import { Router } from "../../navigation/router.js";
import { QrLoginService } from "../../../core/auth/qrLoginService.js";
import { LocalStore } from "../../../core/storage/localStore.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { I18n } from "../../../i18n/index.js";
import { QrCodeGenerator } from "../../../core/qr/qrCodeGenerator.js";

let pollInterval = null;
let countdownInterval = null;
let activeQrSessionId = 0;
const GUEST_QR_BYPASS_KEY = "skipAuthQrGate";

export const AuthQrSignInScreen = {
  async mount({ onboardingMode = false } = {}) {
    this.container = document.getElementById("account");
    this.onboardingMode = Boolean(onboardingMode);
    this.isSignedIn = AuthManager.isAuthenticated;
    this.hasBackDestination = Router.stack.length > 0;
    this.isMounted = true;
    this.isStartingQr = false;
    this.isLeaving = false;
    ScreenUtils.show(this.container);

    this.container.innerHTML = `
      <div class="qr-layout">
        <section class="qr-left-panel">
          <div class="qr-brand-lockup">
            <img src="assets/brand/app_logo_wordmark.png" class="qr-logo" alt="Nuvio" />
          </div>

          <div class="qr-copy-block">
            <h1 class="qr-title">${I18n.t("auth.qr.title")}</h1>
            <p id="qr-description" class="qr-description">${this.getLeftDescription()}</p>
          </div>
        </section>

        <section class="qr-card-panel" aria-label="${I18n.t("auth.qr.cardAriaLabel")}">
          <div class="qr-card">
            <header class="qr-card-header">
              <h2 class="qr-card-title">${I18n.t("auth.qr.cardTitle")}</h2>
              <p id="qr-card-subtitle" class="qr-card-subtitle">${this.getCardSubtitle()}</p>
            </header>

            <div id="qr-container" class="qr-code-frame"></div>
            <div id="qr-code-text" class="qr-code-text"></div>
            <div id="qr-status" class="qr-status">${I18n.t("auth.qr.waitingApproval")}</div>
            <div class="qr-actions">
              <button type="button" id="qr-refresh-btn" class="qr-action-btn qr-action-btn-primary focusable" data-action="refresh">${I18n.t("auth.qr.refresh")}</button>
              <button type="button" id="qr-back-btn" class="qr-action-btn qr-action-btn-secondary focusable" data-action="back">${this.getBackButtonLabel()}</button>
            </div>
          </div>
        </section>
      </div>
    `;

    this.refreshButton = this.container.querySelector("#qr-refresh-btn");
    this.backButton = this.container.querySelector("#qr-back-btn");
    if (this.refreshButton) {
      this.refreshButton.onclick = () => {
        this.handleRefreshAction();
      };
    }
    if (this.backButton) {
      this.backButton.onclick = () => {
        this.handleContinueAction();
      };
    }

    ScreenUtils.indexFocusables(this.container);
    ScreenUtils.setInitialFocus(this.container);
    await this.startQr();
  },

  async startQr() {
    if (!this.isMounted || this.isLeaving || this.isStartingQr) {
      return;
    }
    this.isStartingQr = true;
    this.updateActionButtons();
    this.stopIntervals();
    const sessionId = activeQrSessionId + 1;
    activeQrSessionId = sessionId;
    this.clearQr();
    this.setStatus(I18n.t("auth.qr.preparing"));

    try {
      const result = await QrLoginService.start();
      if (!this.isMounted || sessionId !== activeQrSessionId) {
        return;
      }

      if (!result) {
        const raw = QrLoginService.getLastError();
        this.setStatus(this.toFriendlyQrError(raw));
        return;
      }

      // Only show the reassuring "scan and sign in" status if the QR actually
      // rendered; renderQr sets its own error status on failure.
      const rendered = this.renderQr(result);
      if (!rendered) {
        return;
      }
      this.setStatus(I18n.t("auth.qr.scanAndSignIn"));
      this.startPolling(
        result.code,
        result.deviceNonce,
        result.pollIntervalSeconds || 3,
        sessionId
      );
    } finally {
      if (this.isMounted && sessionId === activeQrSessionId) {
        this.isStartingQr = false;
        this.updateActionButtons();
      }
    }
  },

  renderQr({ qrImageUrl, loginUrl, code }) {
    const qrContainer = this.container?.querySelector("#qr-container");
    const codeText = this.container?.querySelector("#qr-code-text");

    if (!qrContainer || !codeText) {
      return false;
    }

    // Prefer generating the QR locally from the login URL (no network image) so a
    // slow/blocked/rate-limited image request can't leave a silently-blank frame.
    // This mirrors the settings/plugin/supporters screens which already draw QR
    // codes to a canvas via QrCodeGenerator.
    if (loginUrl) {
      try {
        const canvas = document.createElement("canvas");
        canvas.className = "qr-image";
        QrCodeGenerator.generate(canvas, loginUrl, 360);
        qrContainer.innerHTML = "";
        qrContainer.appendChild(canvas);
        codeText.innerText = I18n.t("auth.qr.codeLabel", { code });
        return true;
      } catch (error) {
        console.warn("Local QR generation failed, falling back to remote image", error);
      }
    }

    // Fallback: remote image, but with load/error handlers so a failed fetch
    // surfaces an error and re-enables retry instead of showing a blank frame.
    if (!qrImageUrl) {
      this.setStatus(this.toFriendlyQrError("QR unavailable"));
      return false;
    }
    const img = document.createElement("img");
    img.className = "qr-image";
    img.alt = I18n.t("auth.qr.qrImageAlt");
    img.onerror = () => {
      this.setStatus(this.toFriendlyQrError("QR image failed to load"));
    };
    img.src = qrImageUrl;
    qrContainer.innerHTML = "";
    qrContainer.appendChild(img);
    codeText.innerText = I18n.t("auth.qr.codeLabel", { code });
    return true;
  },

  clearQr() {
    const qrContainer = this.container?.querySelector("#qr-container");
    const codeText = this.container?.querySelector("#qr-code-text");
    if (qrContainer) {
      qrContainer.innerHTML = "";
    }
    if (codeText) {
      codeText.innerText = "";
    }
  },

  startCountdown(expiresAt) {
    const renderRemaining = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        if (countdownInterval) {
          clearInterval(countdownInterval);
          countdownInterval = null;
        }
        return;
      }
    };

    renderRemaining();
    countdownInterval = setInterval(renderRemaining, 1000);
  },

  startPolling(code, deviceNonce, pollIntervalSeconds = 3, sessionId) {
    pollInterval = setInterval(
      async () => {
        const status = await QrLoginService.poll(code, deviceNonce);
        if (!this.isMounted || sessionId !== activeQrSessionId) {
          return;
        }

        if (status === "approved") {
          this.setStatus(I18n.t("auth.qr.approved"));
          clearInterval(pollInterval);
          pollInterval = null;

          const exchange = await QrLoginService.exchange(code, deviceNonce);
          if (sessionId !== activeQrSessionId) {
            return;
          }

          if (exchange) {
            LocalStore.remove(GUEST_QR_BYPASS_KEY);
            LocalStore.set("hasSeenAuthQrOnFirstLaunch", true);
            this.isSignedIn = true;
            Router.navigate("profileSelection");
          } else {
            this.setStatus(this.toFriendlyQrError(QrLoginService.getLastError()));
          }
        }

        if (status === "pending") {
          this.setStatus(I18n.t("auth.qr.waitingApproval"));
        }

        if (status === "expired") {
          this.setStatus(I18n.t("auth.qr.expired"));
        }
      },
      Math.max(2, Number(pollIntervalSeconds || 3)) * 1000
    );
  },

  toFriendlyQrError(rawError) {
    const normalizedError = String(rawError || "")
      .replace(/\s+/g, " ")
      .trim();
    const conciseReason =
      normalizedError.length > 160 ? `${normalizedError.slice(0, 157)}...` : normalizedError;
    const message = normalizedError.toLowerCase();
    if (!message) {
      return I18n.t("auth.qr.unavailable");
    }
    if (
      message.includes("qr auth is not configured") ||
      message.includes("missing redirect_base_url configuration") ||
      message.includes("apikey") ||
      message.includes("api key") ||
      message.includes("anon key")
    ) {
      return I18n.t("auth.qr.notConfigured");
    }
    if (message.includes("invalid tv login redirect base url")) {
      return I18n.t("auth.qr.invalidRedirect");
    }
    if (
      message.includes("start_tv_login_session") &&
      message.includes("could not find the function")
    ) {
      return I18n.t("auth.qr.missingFunction");
    }
    if (message.includes("gen_random_bytes") && message.includes("does not exist")) {
      return I18n.t("auth.qr.missingExtension");
    }
    if (message.includes("network") || message.includes("failed to fetch")) {
      return I18n.t("auth.qr.networkError");
    }
    if (
      message.includes("unsupported method") ||
      message.includes("error response") ||
      message.includes("http 5") ||
      message.includes("http 404") ||
      message.includes("http 405")
    ) {
      return I18n.t("auth.qr.serviceUnavailable");
    }
    return I18n.t("auth.qr.unavailableWithReason", { reason: conciseReason });
  },

  setStatus(text) {
    const statusNode = this.container?.querySelector("#qr-status");
    if (!statusNode) {
      return;
    }
    statusNode.innerText = text;
  },

  updateActionButtons() {
    const refreshButton = this.refreshButton || this.container?.querySelector("#qr-refresh-btn");
    const backButton = this.backButton || this.container?.querySelector("#qr-back-btn");
    const disabled = Boolean(this.isLeaving || this.isStartingQr);
    if (refreshButton instanceof HTMLButtonElement) {
      refreshButton.disabled = disabled;
      refreshButton.setAttribute("aria-busy", this.isStartingQr ? "true" : "false");
    }
    if (backButton instanceof HTMLButtonElement) {
      backButton.disabled = Boolean(this.isLeaving);
    }
  },

  handleRefreshAction() {
    if (this.isLeaving || this.isStartingQr) {
      return;
    }
    this.startQr();
  },

  handleContinueAction() {
    if (this.isLeaving) {
      return;
    }
    this.isLeaving = true;
    this.updateActionButtons();
    LocalStore.set("hasSeenAuthQrOnFirstLaunch", true);
    if (!this.isSignedIn) {
      LocalStore.set(GUEST_QR_BYPASS_KEY, true);
    } else {
      LocalStore.remove(GUEST_QR_BYPASS_KEY);
    }
    this.cleanup();
    if (this.hasBackDestination && this.isSignedIn) {
      Router.back();
      return;
    }
    Router.navigate(
      "home",
      {},
      {
        replaceHistory: true,
        skipStackPush: true
      }
    );
  },

  getLeftDescription() {
    if (this.isSignedIn) {
      return I18n.t("auth.qr.leftDescriptionSignedIn");
    }
    return I18n.t("auth.qr.leftDescriptionSignedOut");
  },

  getCardSubtitle() {
    if (this.isSignedIn) {
      return I18n.t("auth.qr.cardSubtitleSignedIn");
    }
    return I18n.t("auth.qr.cardSubtitleSignedOut");
  },

  getBackButtonLabel() {
    if (this.isSignedIn) {
      return I18n.t("auth.qr.continue");
    }
    return I18n.t("auth.qr.continueWithoutAccount");
  },

  onKeyDown(event) {
    if (ScreenUtils.handleDpadNavigation(event, this.container)) {
      return;
    }
    if (Number(event?.keyCode || 0) !== 13) {
      return;
    }

    const current = this.container?.querySelector(".focusable.focused");
    if (!current) {
      return;
    }

    const action = current.dataset.action;
    if (action === "refresh") {
      this.handleRefreshAction();
      return;
    }
    if (action === "back") {
      this.handleContinueAction();
    }
  },

  consumeBackRequest() {
    this.handleContinueAction();
    return true;
  },

  stopIntervals() {
    if (pollInterval) clearInterval(pollInterval);
    if (countdownInterval) clearInterval(countdownInterval);
    pollInterval = null;
    countdownInterval = null;
  },

  cleanup() {
    this.isMounted = false;
    activeQrSessionId += 1;
    this.stopIntervals();
    if (this.refreshButton) {
      this.refreshButton.onclick = null;
      this.refreshButton = null;
    }
    if (this.backButton) {
      this.backButton.onclick = null;
      this.backButton = null;
    }
    ScreenUtils.hide(this.container);
    this.container = null;
  }
};
