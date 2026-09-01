import type { HttpMockConfig, HttpMockRoute, HttpMockScenario } from '@shared/protocol'

export function emptyRoute(): HttpMockRoute {
  return {
    id: Math.random().toString(36).slice(2),
    name: '新路由',
    enabled: true,
    method: 'GET',
    pathPattern: '/api/example',
    priority: 0,
    mode: 'template',
    respStatus: 200,
    respHeaders: [],
    bodyType: 'json',
    respBody: '{\n  "ok": true\n}',
    delayMs: 0
  }
}

export function emptyScenario(): HttpMockScenario {
  return {
    id: Math.random().toString(36).slice(2),
    name: '新场景',
    note: '',
    overrides: {}
  }
}

export function defaultHttpMockConfig(): HttpMockConfig {
  return {
    enabled: true,
    routes: [
      {
        id: 'demo1',
        name: '示例：健康检查',
        enabled: true,
        method: 'GET',
        pathPattern: '/api/health',
        priority: 10,
        mode: 'template',
        respStatus: 200,
        respHeaders: [],
        bodyType: 'json',
        respBody: '{\n  "status": "ok",\n  "time": "{{now}}"\n}',
        delayMs: 0
      },
      {
        id: 'demo2',
        name: '示例：按 id 查询',
        enabled: true,
        method: 'GET',
        pathPattern: '/api/users/:id',
        priority: 5,
        mode: 'template',
        respStatus: 200,
        respHeaders: [],
        bodyType: 'json',
        respBody: '{\n  "id": "{{path.id}}",\n  "name": "user-{{path.id}}",\n  "reqId": "{{uuid}}"\n}',
        delayMs: 0
      }
    ],
    scenarios: [
      {
        id: 'sc-401',
        name: '登录过期 401',
        note: '所有示例路由统一返回未授权，用于验证前端的重新登录逻辑',
        overrides: {
          demo1: {
            respStatus: 401,
            bodyType: 'json',
            respBody: '{\n  "error": "token_expired",\n  "message": "登录已过期，请重新登录"\n}'
          },
          demo2: {
            respStatus: 401,
            bodyType: 'json',
            respBody: '{\n  "error": "token_expired",\n  "message": "登录已过期，请重新登录"\n}'
          }
        }
      },
      {
        id: 'sc-500',
        name: '服务不可用 500',
        note: '整站故障注入，验证前端兜底与重试',
        overrides: {},
        fault: { enabled: true, failRate: 1, failStatus: 500, extraDelayMs: 0 }
      },
      {
        id: 'sc-slow',
        name: '慢接口 3s',
        note: '统一延迟 3 秒，验证加载态与超时处理',
        overrides: {
          demo1: { delayMs: 3000 },
          demo2: { delayMs: 3000 }
        }
      },
      {
        id: 'sc-offline',
        name: '接口未上线 404',
        note: '临时禁用示例路由，未命中走 404',
        overrides: {
          demo1: { enabled: false },
          demo2: { enabled: false }
        }
      }
    ],
    fault: { enabled: false, failRate: 0, failStatus: 500, extraDelayMs: 0 },
    fallthrough: 'notFound',
    corsEnabled: true
  }
}