import Homey from 'homey';
import type PairSession from 'homey/lib/PairSession';
import { HaasSohnApi } from '../../lib/haassohn-api.js';

module.exports = class PelletStoveDriver extends Homey.Driver {
  async onInit() {
    this.log('Pellet stove driver initialized');
  }

  async onPair(session: PairSession) {
    this.log('Pairing session started');
    session.setHandler('disconnect', async () => {
      this.log('Pairing session disconnected');
    });

    session.setHandler('testConnection', async (data: { address?: string; pin?: string; port?: number | string }) => {
      this.log('testConnection called', data);
      const address = normalizeAddress(data.address, data.port);
      const pin = (data.pin ?? '').trim();

      if (!address) {
        return { ok: false, error: 'Address is required' };
      }

      try {
        const api = new HaasSohnApi(address, pin, 5000);
        const status = await api.getStatus();
        return { ok: true, status };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });

    session.setHandler('addDevice', async (data: { address?: string; pin?: string; name?: string; pollInterval?: number; port?: number | string }) => {
      this.log('addDevice called', data);
      const address = normalizeAddress(data.address, data.port);
      const pin = (data.pin ?? '').trim();
      const pollInterval = Number.isFinite(data.pollInterval) ? Number(data.pollInterval) : 10;
      const port = Number.isFinite(Number(data.port)) ? Number(data.port) : undefined;

      if (!address) {
        throw new Error('Address is required');
      }

      return {
        name: data.name?.trim() || `Haas+Sohn stove (${address})`,
        data: {
          id: address,
        },
        settings: {
          address,
          pin,
          port,
          pollInterval,
        },
      };
    });
  }
};

function normalizeAddress(address?: string, port?: number | string) {
  const trimmed = (address ?? '').trim();
  if (!trimmed) return '';
  const portNumber = Number(port);
  if (Number.isFinite(portNumber)) {
    if (!/:\d+$/.test(trimmed)) {
      return `${trimmed}:${portNumber}`;
    }
  }
  return trimmed;
}
