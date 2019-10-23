/**
 * Copyright 2019 AXA Group Operations S.A.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { readdirSync, readFileSync } from 'fs';
export interface ConfigFile {
	version: number;
	extractor: object;
	cleaner: object[];
	output: object[];
}

export class ServerManager {
	private defaultConfigPath: string = `../../server/defaultConfig.json`;
	private defaultModulesFolder: string = `../../server/src/processing`;

	/**
	 * Returns the default configuration of the server
	 */
	public getDefaultConfig(): ConfigFile {
		return JSON.parse(readFileSync(this.defaultConfigPath, 'utf-8'));
	}

	public getDefaultConfigWithSpecs(): ConfigFile {
		const mainDefaultConfig = this.getDefaultConfig();
		mainDefaultConfig.cleaner = mainDefaultConfig.cleaner.map(this.fillModuleWithSpecs.bind(this));
		return mainDefaultConfig;
	}

	/**
	 * Returns all the modules on the server
	 */
	public getModules(): string[] {
		return readdirSync(this.defaultModulesFolder, { withFileTypes: true })
			.filter(dirent => dirent.isDirectory())
			.map(dirent => dirent.name)
			.map(d => d.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase())
			.map(d => d.replace(/-module/g, ''));
	}

	/**
	 * Returns the defaultConfig of the module asked for
	 * @param moduleName the name of the module in snake-case
	 */
	public getModuleConfig(moduleName: string): object {
		moduleName += '-module';
		const moduleFolderName = moduleName
			.split('-')
			.map(w => w[0].toUpperCase() + w.substr(1).toLowerCase())
			.join('');
		return JSON.parse(
			readFileSync(
				this.defaultModulesFolder + '/' + moduleFolderName + '/defaultConfig.json',
				'utf-8',
			),
		);
	}

	private fillModuleWithSpecs(mod: object): object {
		const [moduleName, customConfig] = Array.isArray(mod) ? mod : [mod, {}];

		const { specs } = this.getModuleConfig(moduleName) as any;

		// merges custom parameter values with the value in the module specs
		Object.keys(customConfig).forEach(key => {
			specs[key].value = customConfig[key];
		});

		const mergedResult = [moduleName, specs].filter(m => !!m);

		// if length === 2, config has parameters. if not, i return only the module name as a string
		return mergedResult.length === 2 ? mergedResult : mergedResult[0];
	}
}
