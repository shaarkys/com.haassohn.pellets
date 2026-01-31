import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { createHash } from 'crypto';

export type HaasSohnStatus = Record<string, unknown>;

type RequestResult = {
  statusCode: number;
  body: string;
};

export class HaasSohnApi {
  private address: string;
  private pin: string;
  private hpin: string;
  private hspin: string | null = null;
  private nonce: string | null = null;
  private timeoutMs: number;

  constructor(address: string, pin: string, timeoutMs = 5000) {
    this.address = address;
    this.pin = pin;
    this.hpin = HaasSohnApi.md5(pin);
    this.timeoutMs = timeoutMs;
  }

  setConfig(address: string, pin: string) {
    this.address = address;
    this.pin = pin;
    this.hpin = HaasSohnApi.md5(pin);
    this.hspin = null;
    this.nonce = null;
  }

  getAddress() {
    return this.address;
  }

  getNonce() {
    return this.nonce;
  }

  setNonce(nonce: string) {
    this.nonce = nonce;
    this.hspin = HaasSohnApi.md5(nonce + this.hpin);
  }

  async getStatus(): Promise<HaasSohnStatus> {
    const response = await this.request('/status.cgi', 'GET');
    if (response.statusCode !== 200) {
      throw new Error(`Unexpected status code ${response.statusCode}`);
    }

    let parsed: HaasSohnStatus;
    try {
      parsed = JSON.parse(response.body) as HaasSohnStatus;
    } catch (error) {
      throw new Error(`Invalid JSON response: ${error}`);
    }

    const meta = parsed.meta as Record<string, unknown> | undefined;
    const nonce = meta?.nonce;
    if (typeof nonce === 'string' && nonce.length > 0) {
      this.setNonce(nonce);
    }

    return parsed;
  }

  async postStatus(payload: Record<string, unknown>): Promise<void> {
    if (!this.hspin) {
      await this.getStatus();
    }

    const body = JSON.stringify(payload);
    const response = await this.request('/status.cgi', 'POST', body, this.createHeaders(body));
    if (response.statusCode !== 200) {
      throw new Error(`Unexpected status code ${response.statusCode}`);
    }
  }

  private static md5(value: string): string {
    return createHash('md5').update(value).digest('hex');
  }

  private createHeaders(body: string): Record<string, string> {
    return {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Connection: 'keep-alive',
      'Content-Length': Buffer.byteLength(body).toString(),
      'Content-Type': 'application/json',
      'User-Agent': 'homey-haassohn',
      'X-HS-PIN': this.hspin ?? '',
    };
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: string,
    headers?: Record<string, string>,
  ): Promise<RequestResult> {
    const url = this.normalizeAddress();
    const isHttps = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port,
      path,
      headers,
    };

    const requester = isHttps ? https.request : http.request;

    return new Promise((resolve, reject) => {
      const req = requester(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.on('error', (error) => reject(error));
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('Request timeout')));

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  private normalizeAddress(): URL {
    const trimmed = this.address.trim();
    if (!trimmed) {
      throw new Error('Device address is not configured');
    }
    const withProtocol = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
    return new URL(withProtocol);
  }
}
