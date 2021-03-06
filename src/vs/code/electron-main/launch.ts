/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { IChannel } from 'vs/base/parts/ipc/common/ipc';
import { ILogService } from 'vs/platform/log/common/log';
import { IURLService } from 'vs/platform/url/common/url';
import { IProcessEnvironment } from 'vs/base/common/platform';
import { ParsedArgs } from 'vs/platform/environment/common/environment';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { OpenContext } from 'vs/platform/windows/common/windows';
import { IWindowsMainService, ICodeWindow } from 'vs/platform/windows/electron-main/windows';
import { whenDeleted } from 'vs/base/node/pfs';
import { IWorkspacesMainService } from 'vs/platform/workspaces/common/workspaces';

export const ID = 'launchService';
export const ILaunchService = createDecorator<ILaunchService>(ID);

export interface IStartArguments {
	args: ParsedArgs;
	userEnv: IProcessEnvironment;
}

export interface IWindowInfo {
	pid: number;
	title: string;
	folders: string[];
}

export interface IMainProcessInfo {
	mainPID: number;
	mainArguments: string[];
	windows: IWindowInfo[];
}

export interface ILaunchService {
	_serviceBrand: any;
	start(args: ParsedArgs, userEnv: IProcessEnvironment): TPromise<void>;
	getMainProcessId(): TPromise<number>;
	getMainProcessInfo(): TPromise<IMainProcessInfo>;
}

export interface ILaunchChannel extends IChannel {
	call(command: 'start', arg: IStartArguments): TPromise<void>;
	call(command: 'get-main-process-id', arg: null): TPromise<any>;
	call(command: 'get-main-process-info', arg: null): TPromise<any>;
	call(command: string, arg: any): TPromise<any>;
}

export class LaunchChannel implements ILaunchChannel {

	constructor(private service: ILaunchService) { }

	public call(command: string, arg: any): TPromise<any> {
		switch (command) {
			case 'start':
				const { args, userEnv } = arg as IStartArguments;
				return this.service.start(args, userEnv);

			case 'get-main-process-id':
				return this.service.getMainProcessId();

			case 'get-main-process-info':
				return this.service.getMainProcessInfo();
		}

		return undefined;
	}
}

export class LaunchChannelClient implements ILaunchService {

	_serviceBrand: any;

	constructor(private channel: ILaunchChannel) { }

	public start(args: ParsedArgs, userEnv: IProcessEnvironment): TPromise<void> {
		return this.channel.call('start', { args, userEnv });
	}

	public getMainProcessId(): TPromise<number> {
		return this.channel.call('get-main-process-id', null);
	}

	public getMainProcessInfo(): TPromise<IMainProcessInfo> {
		return this.channel.call('get-main-process-info', null);
	}
}

export class LaunchService implements ILaunchService {

	_serviceBrand: any;

	constructor(
		@ILogService private logService: ILogService,
		@IWindowsMainService private windowsMainService: IWindowsMainService,
		@IURLService private urlService: IURLService,
		@IWorkspacesMainService private workspacesMainService: IWorkspacesMainService
	) { }

	public start(args: ParsedArgs, userEnv: IProcessEnvironment): TPromise<void> {
		this.logService.trace('Received data from other instance: ', args, userEnv);

		// Check early for open-url which is handled in URL service
		const openUrl = this.startOpenUrl(args);
		if (openUrl) {
			return openUrl;
		}

		// Otherwise handle in windows service
		return this.startOpenWindow(args, userEnv);
	}

	private startOpenUrl(args: ParsedArgs): TPromise<void> {
		const openUrlArg = args['open-url'] || [];
		const openUrl = typeof openUrlArg === 'string' ? [openUrlArg] : openUrlArg;
		if (openUrl.length > 0) {
			openUrl.forEach(url => this.urlService.open(url));

			return TPromise.as(null);
		}

		return void 0;
	}

	private startOpenWindow(args: ParsedArgs, userEnv: IProcessEnvironment): TPromise<void> {
		const context = !!userEnv['VSCODE_CLI'] ? OpenContext.CLI : OpenContext.DESKTOP;
		let usedWindows: ICodeWindow[];
		if (!!args.extensionDevelopmentPath) {
			this.windowsMainService.openExtensionDevelopmentHostWindow({ context, cli: args, userEnv });
		} else if (args._.length === 0 && (args['new-window'] || args['unity-launch'])) {
			usedWindows = this.windowsMainService.open({ context, cli: args, userEnv, forceNewWindow: true, forceEmpty: true });
		} else if (args._.length === 0) {
			usedWindows = [this.windowsMainService.focusLastActive(args, context)];
		} else {
			usedWindows = this.windowsMainService.open({
				context,
				cli: args,
				userEnv,
				forceNewWindow: args['new-window'],
				preferNewWindow: !args['reuse-window'] && !args.wait,
				forceReuseWindow: args['reuse-window'],
				diffMode: args.diff,
				addMode: args.add
			});
		}

		// If the other instance is waiting to be killed, we hook up a window listener if one window
		// is being used and only then resolve the startup promise which will kill this second instance.
		// In addition, we poll for the wait marker file to be deleted to return.
		if (args.wait && usedWindows.length === 1 && usedWindows[0]) {
			return TPromise.any([
				this.windowsMainService.waitForWindowCloseOrLoad(usedWindows[0].id),
				whenDeleted(args.waitMarkerFilePath)
			]).then(() => void 0, () => void 0);
		}

		return TPromise.as(null);
	}

	public getMainProcessId(): TPromise<number> {
		this.logService.trace('Received request for process ID from other instance.');

		return TPromise.as(process.pid);
	}

	public getMainProcessInfo(): TPromise<IMainProcessInfo> {
		this.logService.trace('Received request for main process info from other instance.');

		return TPromise.wrap({
			mainPID: process.pid,
			mainArguments: process.argv,
			windows: this.windowsMainService.getWindows().map(window => {
				return this.getWindowInfo(window);
			})
		} as IMainProcessInfo);
	}

	private getWindowInfo(window: ICodeWindow): IWindowInfo {
		const folders: string[] = [];

		if (window.openedFolderPath) {
			folders.push(window.openedFolderPath);
		} else if (window.openedWorkspace) {
			const rootFolders = this.workspacesMainService.resolveWorkspaceSync(window.openedWorkspace.configPath).folders;
			rootFolders.forEach(root => {
				if (root.uri.scheme === 'file') {
					folders.push(root.uri.fsPath);
				}
			});
		}

		return {
			pid: window.win.webContents.getOSProcessId(),
			title: window.win.getTitle(),
			folders
		} as IWindowInfo;
	}
}