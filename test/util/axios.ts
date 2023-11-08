import axiosStatic from 'axios';
import axiosRetry from 'axios-retry';
import { expect } from 'chai';

export default class AxiosUtils {
  static buildAxiosOption(method: string, url: string, body: any, headers?: Record<string, string>) {
    const option: any = {
      method: method,
      url: url,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    if (body) {
      option['data'] = body;
    }
    return option;
  }

  static async call(method: string, url: string, body: any, headers?: Record<string, string>) {
    const axios = axiosStatic.create();

    axiosRetry(axios, {
      retries: 2,
      retryCondition: (err) => err.response?.status == 429,
      retryDelay: axiosRetry.exponentialDelay,
    });

    const option = AxiosUtils.buildAxiosOption(method, url, body, headers);
    const { data, status } = await axios(option);

    return {
      data,
      status,
    };
  }

  static async callPassThroughFail(method: string, url: string, body: any, headers?: Record<string, string>) {
    const axios = axiosStatic.create();

    axiosRetry(axios, {
      retries: 2,
      retryCondition: (err) => err.response?.status == 429,
      retryDelay: axiosRetry.exponentialDelay,
    });

    const option = AxiosUtils.buildAxiosOption(method, url, body, headers);
    try {
      const { data, status } = await axios(option);
      return {
        data,
        status,
      }
    } catch (err: any) {
      if (err.response) {
        return {
          data: err.response.data,
          status: err.response.status,
        }
      }
      throw err;
    }
  }

  static async callAndExpectFail(
    method: string,
    url: string,
    body: any,
    resp: { status: number; data: any },
    headers?: Record<string, string>
  ) {
    try {
      await AxiosUtils.call(method, url, body, headers);
      fail();
    } catch (err: any) {
      expect(err.response).to.containSubset(resp);
    }
  }
}
