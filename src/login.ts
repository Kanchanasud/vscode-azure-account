//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from '@azure/ms-rest-azure-env';
import { AuthenticationContext, TokenResponse } from 'adal-node';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import { parse, ParsedUrlQuery } from 'querystring';
import * as url from 'url';
import * as vscode from 'vscode';

export const redirectUrlAAD = 'https://vscode-redirect.azurewebsites.net/';
const portADFS = 19472;
const redirectUrlADFS = `http://127.0.0.1:${portADFS}/callback`;

export function isADFS(environment: Environment): boolean {
	const u = url.parse(environment.activeDirectoryEndpointUrl);
	const pathname = (u.pathname || '').toLowerCase();
	return pathname === '/adfs' || pathname.startsWith('/adfs/');
}

export async function checkRedirectServer(adfs: boolean): Promise<boolean> {
	if (adfs) {
		return true;
	}
	let timer: NodeJS.Timer | undefined;
	const promise = new Promise<boolean>(resolve => {
		const req = https.get({
			...url.parse(`${redirectUrlAAD}?state=3333,cccc`),
		}, res => {
			const key = Object.keys(res.headers)
				.find(key => key.toLowerCase() === 'location');
			const location = key && res.headers[key]
			resolve(res.statusCode === 302 && typeof location === 'string' && location.startsWith('http://127.0.0.1:3333/callback'));
		});
		req.on('error', err => {
			console.error(err);
			resolve(false);
		});
		req.on('close', () => {
			resolve(false);
		});
		timer = setTimeout(() => {
			resolve(false);
			req.abort();
		}, 5000);
	});
	function cancelTimer() {
		if (timer) {
			clearTimeout(timer);
		}
	}
	promise.then(cancelTimer, cancelTimer);
	return promise;
}

let terminateServer: () => Promise<void>;

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
function parseQuery(uri: vscode.Uri): any {
	return uri.query.split('&').reduce((prev: any, current) => {
		const queryString = current.split('=');
		prev[queryString[0]] = queryString[1];
		return prev;
	}, {});
}
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

class UriEventHandler extends vscode.EventEmitter<vscode.Uri> implements vscode.UriHandler {
	public handleUri(uri: vscode.Uri) {
		this.fire(uri);
	}
}

const handler = new UriEventHandler();

vscode.window.registerUriHandler(handler);

async function exchangeCodeForToken(clientId: string, environment: Environment, tenantId: string, callbackUri: string, state: string) {
	let uriEventListener: vscode.Disposable;
	return new Promise((resolve: (value: TokenResponse) => void , reject) => {
		uriEventListener = handler.event(async (uri: vscode.Uri) => {
			try {
				/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
				const query = parseQuery(uri);
				const code = query.code;
	
				// Workaround double encoding issues of state
				if (query.state !== state && decodeURIComponent(query.state) !== state) {
					throw new Error('State does not match.');
				}
				/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
	
				resolve(await tokenWithAuthorizationCode(clientId, environment, callbackUri, tenantId, code));
			} catch (err) {
				reject(err);
			}
		});
	}).then(result => {
		uriEventListener.dispose()
		return result;
	}).catch(err => {
		uriEventListener.dispose();
		throw err;
	});
}

function getCallbackEnvironment(callbackUri: vscode.Uri): string {
	if (callbackUri.authority.endsWith('.workspaces.github.com') || callbackUri.authority.endsWith('.github.dev')) {
		return `${callbackUri.authority},`;
	}

	switch (callbackUri.authority) {
		case 'online.visualstudio.com':
			return 'vso,';
		case 'online-ppe.core.vsengsaas.visualstudio.com':
			return 'vsoppe,';
		case 'online.dev.core.vsengsaas.visualstudio.com':
			return 'vsodev,';
		case 'canary.online.visualstudio.com':
			return 'vsocanary,';
		default:
			return '';
	}
}

async function loginWithoutLocalServer(clientId: string, environment: Environment, adfs: boolean, tenantId: string): Promise<TokenResponse> {
	const callbackUri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://ms-vscode.azure-account`));
	const callback = redirectUrlAAD;
	const nonce = crypto.randomBytes(16).toString('base64');
	const port = (callbackUri.authority.match(/:([0-9]*)$/) || [])[1] || (callbackUri.scheme === 'https' ? 443 : 80);
	const callbackEnvironment = getCallbackEnvironment(callbackUri);
	const state = `${callbackEnvironment}${port},${encodeURIComponent(nonce)},${encodeURIComponent(callbackUri.query)}`;
	const signInUrl = `${environment.activeDirectoryEndpointUrl}${adfs ? '' : `${tenantId}/`}oauth2/authorize`;
	let uri = vscode.Uri.parse(signInUrl);
	uri = uri.with({
		query: `response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${callback}&state=${state}&resource=${environment.activeDirectoryResourceId}&prompt=select_account`
	});
	void vscode.env.openExternal(uri);

	const timeoutPromise = new Promise((resolve: (value: TokenResponse) => void, reject) => {
		const wait = setTimeout(() => {
			clearTimeout(wait);
			reject('Login timed out.');
		}, 1000 * 60 * 5)
	});

	return Promise.race([exchangeCodeForToken(clientId, environment, tenantId, callback, state), timeoutPromise]);
}

export async function login(clientId: string, environment: Environment, adfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>, redirectTimeout: () => Promise<void>): Promise<TokenResponse> {
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		return loginWithoutLocalServer(clientId, environment, adfs, tenantId);
	}

	if (adfs && terminateServer) {
		await terminateServer();
	}

	const nonce = crypto.randomBytes(16).toString('base64');
	const { server, redirectPromise, codePromise } = createServer(nonce);

	if (adfs) {
		terminateServer = createTerminateServer(server);
	}

	try {
		const port = await startServer(server, adfs);
		await openUri(`http://localhost:${port}/signin?nonce=${encodeURIComponent(nonce)}`);
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		const redirectTimer = setTimeout(() => redirectTimeout().catch(console.error), 10*1000);

		const redirectReq = await redirectPromise;
		if ('err' in redirectReq) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const { err, res } = redirectReq;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
			res.end();
			throw err;
		}

		clearTimeout(redirectTimer);
		const host = redirectReq.req.headers.host || '';
		const updatedPortStr = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
		const updatedPort = updatedPortStr ? parseInt(updatedPortStr, 10) : port;

		const state = `${updatedPort},${encodeURIComponent(nonce)}`;
		const redirectUrl = adfs ? redirectUrlADFS : redirectUrlAAD;
		const signInUrl = `${environment.activeDirectoryEndpointUrl}${adfs ? '' : `${tenantId}/`}oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&resource=${encodeURIComponent(environment.activeDirectoryResourceId)}&prompt=select_account`;
		redirectReq.res.writeHead(302, { Location: signInUrl })
		redirectReq.res.end();

		const codeRes = await codePromise;
		const res = codeRes.res;
		try {
			if ('err' in codeRes) {
				throw codeRes.err;
			}
			const tokenResponse = await tokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, codeRes.code);
			res.writeHead(302, { Location: '/' });
			res.end();
			return tokenResponse;
		} catch (err) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
			res.end();
			throw err;
		}
	} finally {
		setTimeout(() => {
			server.close();
		}, 5000);
	}
}

function createTerminateServer(server: http.Server) {
	const sockets: Record<number, net.Socket> = {};
	let socketCount = 0;
	server.on('connection', socket => {
		const id = socketCount++;
		sockets[id] = socket;
		socket.on('close', () => {
			delete sockets[id];
		});
	});
	return async () => {
		const result = new Promise<void>((resolve: () => void) => server.close(resolve));
		for (const id in sockets) {
			sockets[id].destroy();
		}
		return result;
	};
}

interface Deferred<T> {
	resolve: (result: T | Promise<T>) => void;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	reject: (reason: any) => void;
}

function createServer(nonce: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type RedirectResult = { req: http.IncomingMessage, res: http.ServerResponse } | { err: any; res: http.ServerResponse; };
	let deferredRedirect: Deferred<RedirectResult>;
	const redirectPromise = new Promise<RedirectResult>((resolve, reject) => deferredRedirect = { resolve, reject });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type CodeResult = { code: string; res: http.ServerResponse; } | { err: any; res: http.ServerResponse; };
	let deferredCode: Deferred<CodeResult>;
	const codePromise = new Promise<CodeResult>((resolve, reject) => deferredCode = { resolve, reject });

	const codeTimer = setTimeout(() => {
		deferredCode.reject(new Error('Timeout waiting for code'));
	}, 5 * 60 * 1000);
	function cancelCodeTimer() {
		clearTimeout(codeTimer);
	}
	const server = http.createServer(function (req, res) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const reqUrl = url.parse(req.url!, /* parseQueryString */ true);
		switch (reqUrl.pathname) {
			case '/signin':
				const receivedNonce = (reqUrl.query.nonce.toString() || '').replace(/ /g, '+');
				if (receivedNonce === nonce) {
					deferredRedirect.resolve({ req, res });
				} else {
					const err = new Error('Nonce does not match.');
					deferredRedirect.resolve({ err, res });
				}
				break;
			case '/':
				sendFile(res, path.join(__dirname, '../codeFlowResult/index.html'), 'text/html; charset=utf-8');
				break;
			case '/main.css':
				sendFile(res, path.join(__dirname, '../codeFlowResult/main.css'), 'text/css; charset=utf-8');
				break;
			case '/callback':
				deferredCode.resolve(callback(nonce, reqUrl)
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
					.then(code => ({ code, res }), err => ({ err, res })));
				break;
			default:
				res.writeHead(404);
				res.end();
				break;
		}
	});
	codePromise.then(cancelCodeTimer, cancelCodeTimer);
	return {
		server,
		redirectPromise,
		codePromise
	};
}

function sendFile(res: http.ServerResponse, filepath: string, contentType: string) {
	fs.readFile(filepath, (err, body) => {
		if (err) {
			console.error(err);
		} else {
			res.writeHead(200, {
				'Content-Length': body.length,
				'Content-Type': contentType
			});
			res.end(body);
		}
	});
}

async function startServer(server: http.Server, adfs: boolean) {
	let portTimer: NodeJS.Timer;
	function cancelPortTimer() {
		clearTimeout(portTimer);
	}
	const port = new Promise<number>((resolve, reject) => {
		portTimer = setTimeout(() => {
			reject(new Error('Timeout waiting for port'));
		}, 5000);
		server.on('listening', () => {
			const address: string | net.AddressInfo | null = server.address();
			if (address && typeof address !== 'string') {
				resolve(address.port);
			}
		});
		server.on('error', err => {
			reject(err);
		});
		server.on('close', () => {
			reject(new Error('Closed'));
		});
		server.listen(adfs ? portADFS : 0, '127.0.0.1');
	});
	port.then(cancelPortTimer, cancelPortTimer);
	return port;
}

async function callback(nonce: string, reqUrl: url.Url): Promise<string> {
	let query: ParsedUrlQuery;
	let error: string | undefined;
	let code: string | undefined;

	if (reqUrl.query) {
		query = typeof reqUrl.query === 'string' ? parse(reqUrl.query) : reqUrl.query;
		error = getQueryProp(query, 'error_description') || getQueryProp(query, 'error');
		code = getQueryProp(query, 'code');

		if (!error) {
			const state: string = getQueryProp(query, 'state');
			const receivedNonce: string = (state?.split(',')[1] || '').replace(/ /g, '+');

			if (receivedNonce !== nonce) {
				error = 'Nonce does not match.';
			}
		}
	}

	if (!error && code) {
		return code;
	}

	throw new Error(error || 'No code received.');
}

function getQueryProp(query: ParsedUrlQuery, propName: string): string {
	const value = query[propName];
	return typeof value === 'string' ? value : '';
}

export async function tokenWithAuthorizationCode(clientId: string, environment: Environment, redirectUrl: string, tenantId: string, code: string): Promise<TokenResponse> {
	return new Promise<TokenResponse>((resolve, reject) => {
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, !isADFS(environment));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		context.acquireTokenWithAuthorizationCode(code, redirectUrl, environment.activeDirectoryResourceId, clientId, <any>undefined, (err, response) => {
			if (err) {
				reject(err);
			} if (response && response.error) {
				reject(new Error(`${response.error}: ${response.errorDescription}`));
			} else {
				resolve(<TokenResponse>response);
			}
		});
	});
}

if (require.main === module) {
	login('aebc6443-996d-45c2-90f0-388ff96faa56', Environment.AzureCloud, false, 'common', async uri => console.log(`Open: ${uri}`), async () => console.log('Browser did not connect to local server within 10 seconds.'))
		.catch(console.error);
}