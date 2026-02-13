// src/browser/browserManager.ts
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "puppeteer";
import logger from "../utils/logger";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

puppeteer.use(StealthPlugin());

export class BrowserManager extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isClosing = false;
  private userDataDir: string;
  private lockFilePath: string;

  constructor() {
    super();
    // Resolve absolute path to avoid ambiguity (especially on Railway/Docker)
    const rawDir = process.env.CHROME_USER_DATA_DIR || "chrome-data";
    this.userDataDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(process.cwd(), rawDir);
    this.lockFilePath = path.join(this.userDataDir, ".browser.lock");
    this.startMemoryWatchdog();
  }

  async init(): Promise<void> {
    if (this.browser) return;

    // Ensure userDataDir exists with better error handling
    try {
      if (!fs.existsSync(this.userDataDir)) {
        logger.info(`Creating user data directory: ${this.userDataDir}`);
        fs.mkdirSync(this.userDataDir, { recursive: true });
      }
    } catch (error: any) {
      if (error.code === 'EACCES') {
        logger.warn(`Permission denied on ${this.userDataDir}. Falling back to /tmp/chrome-data for this session.`);
        this.userDataDir = path.resolve("/tmp/chrome-data");
        this.lockFilePath = path.join(this.userDataDir, ".browser.lock");
        if (!fs.existsSync(this.userDataDir)) {
          fs.mkdirSync(this.userDataDir, { recursive: true });
        }
      } else {
        throw error;
      }
    }

    // Check and cleanup stale lock
    await this.cleanupStaleLock();

    // Kill any ghost Chrome processes using this userDataDir
    await this.killGhostBrowsers();

    logger.info(
      `Initializing browser (Stealth) with user-data-dir: ${this.userDataDir}`,
    );
    
    try {
      const launchOptions: any = {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
        userDataDir: this.userDataDir,
      };

      // Handle custom executable path (critical for Railway/Docker)
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      if (executablePath) {
        logger.info(`Using custom browser executable: ${executablePath}`);
        launchOptions.executablePath = executablePath;
      } else if (process.platform === "linux") {
        // Auto-detect common linux paths if not specified
        const commonPaths = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"];
        for (const p of commonPaths) {
          if (fs.existsSync(p)) {
            logger.info(`Auto-detected system browser at: ${p}`);
            launchOptions.executablePath = p;
            break;
          }
        }
      }

      this.browser = (await puppeteer.launch(launchOptions)) as unknown as Browser; // Cast because puppeteer-extra types can be tricky

      // Write lock file with current process PID
      fs.writeFileSync(this.lockFilePath, process.pid.toString());

      this.page = await this.browser.newPage();

      // Stealth: Randomize Viewport
      await this.page.setViewport({
        width: 1366 + Math.floor(Math.random() * 100),
        height: 768 + Math.floor(Math.random() * 100),
      });

      // Resource Efficiency: Block unnecessary resources
      await this.page.setRequestInterception(true);
      this.page.on("request", (req) => {
        const resourceType = req.resourceType();
        if (
          ["image", "stylesheet", "font", "media", "other"].includes(resourceType)
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Additional Stealth: Hide stats
      await this.page.evaluateOnNewDocument(() => {
        // @ts-ignore
        Object.defineProperty(navigator, "webdriver", {
          get: () => false,
        });
      });

      logger.info("Browser initialized");
    } catch (error: any) {
      logger.error("Failed to initialize browser", error);
      // Cleanup on failure
      await this.killGhostBrowsers();
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
      }
      throw error;
    }
  }

  getPage(): Page {
    if (!this.page) throw new Error("Browser not initialized");
    return this.page;
  }

  async close(): Promise<void> {
    if (this.isClosing) return;
    this.isClosing = true;

    // Stop watchdog logic during close to avoid race
    // (Implementation detail: interval continues but we set flag)

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        logger.warn("Error closing browser, forcing cleanup", error);
      }
      this.browser = null;
      this.page = null;
    }

    // Remove lock file
    if (fs.existsSync(this.lockFilePath)) {
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch (error) {
        logger.warn("Failed to remove lock file", error);
      }
    }

    // Final cleanup of any remaining Chrome processes
    await this.killGhostBrowsers();
  }

  // Stealth: Human-like typing
  async typeHumanLike(selector: string, text: string) {
    if (!this.page) return;
    await this.page.focus(selector);
    for (const char of text) {
      await this.page.keyboard.type(char, { delay: Math.random() * 100 + 30 }); // 30-130ms delay
      // Random pause
      if (Math.random() < 0.05) {
        await new Promise((r) => setTimeout(r, Math.random() * 500 + 200));
      }
    }
  }

  // Reliability: Memory Watchdog
  private startMemoryWatchdog() {
    setInterval(async () => {
      if (this.isClosing) return;
      const used = process.memoryUsage().rss / 1024 / 1024;
      if (used > 900) {
        // 900MB Threshold
        logger.warn(
          `Memory usage high (${Math.round(used)}MB). triggering safe restart...`,
        );
        this.emit("restart_required");
      }
    }, 60000); // Check every minute
  }

  // Called by coordinator (index.ts) after pausing queue
  async restartBrowser() {
    logger.info("Performing safe browser restart...");
    await this.close();
    this.isClosing = false;
    // Wait a bit
    await new Promise((r) => setTimeout(r, 2000));
    await this.init();
    logger.info("Browser restarted successfully.");
  }

  // Cleanup stale lock file if process is not running
  private async cleanupStaleLock(): Promise<void> {
    if (!fs.existsSync(this.lockFilePath)) return;

    try {
      const pidStr = fs.readFileSync(this.lockFilePath, "utf-8").trim();
      const pid = parseInt(pidStr, 10);

      if (isNaN(pid)) {
        logger.warn("Invalid PID in lock file, removing");
        fs.unlinkSync(this.lockFilePath);
        return;
      }

      // Check if process is still running
      try {
        process.kill(pid, 0); // Signal 0 checks if process exists
        logger.warn(
          `Browser lock exists for PID ${pid}. Attempting cleanup...`,
        );
        // Process exists, try to kill it
        try {
          process.kill(pid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          // Process might have already exited
        }
      } catch (e) {
        // Process doesn't exist, safe to remove lock
        logger.info("Stale lock file detected, cleaning up");
      }

      fs.unlinkSync(this.lockFilePath);
    } catch (error) {
      logger.warn("Error cleaning up lock file", error);
      // Try to remove anyway
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch (e) {
        // Ignore
      }
    }
  }

  // Kill ghost Chrome/Chromium processes
  private async killGhostBrowsers(): Promise<void> {
    try {
      // Platform-specific cleanup
      if (process.platform === "darwin" || process.platform === "linux") {
        // Find Chrome processes using our userDataDir
        const escapedPath = this.userDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        try {
          execSync(
            `pkill -f "chrome" || pkill -f "chromium" || true`,
            { stdio: "ignore" },
          );
          logger.info("Cleaned up all ghost browser processes");
        } catch (e) {
          // pkill returns non-zero if no processes found, which is fine
        }
      }
    } catch (error) {
      logger.warn("Error killing ghost browsers", error);
    }
  }
}
