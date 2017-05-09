/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');
const reporter = require('./reporter');
const yaml = require('js-yaml');

const { DocumentationFile } = require('./documentation-file');
const { PLATFORM_CONFIG_PATH, BuildDir, FilePattern } = require('./project-paths');
const { SectionNavigation } = require('./section-navigation');
const { rewriteLocalLinks } = require('./rewrite-local-links');
const { sync: globSync } = require('glob');


const GLOB_OPTIONS = {
  ignore: ['**/node_modules/**'],
  dot: true,
};


class PlatformSite {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.config = readYaml(path.join(repoPath, PLATFORM_CONFIG_PATH));
    this.files_ = null;
  }

  get repoUrl() {
    return this.config.repo_url;
  }

  get repoStableBranch() {
    return this.config.repo_stable_branch || 'master';
  }

  get basepath() {
    return this.config.basepath;
  }

  get files() {
    if (!this.files_) {
      this.files_ = globSync(path.join(this.repoPath, FilePattern.JEKYLL_FILES), GLOB_OPTIONS)
          .map((filePath) => DocumentationFile.readFromPath(filePath, this.repoPath))
          .filter((file) => file.isValidJekyll);
    }

    return this.files_;
  }

  get directoryPaths() {
    return globSync(path.join(this.repoPath, FilePattern.DOCS_DIRS), GLOB_OPTIONS);
  }

  get filesBySection() {
    if (!this.filesBySection_) {
      this.filesBySection_ = this.files.reduce((map, file) => {
        const section = file.jekyllMetadata.section;
        if (!section) {
          return map;
        }

        if (!map.has(section)) {
          map.set(section, []);
        }
        map.get(section).push(file);
        return map;
      }, new Map);
    }

    return this.filesBySection_;
  }

  prepareForBuild() {
    if (!this.validateFiles_(this.files)) {
      throw new Error(`Repo at ${ this.repoPath } invalid.`);
    }

    this.prepareFiles_(this.files);
    this.buildNavigation_(this.filesBySection);
    this.files.forEach((file) => file.write());
  }

  validateFiles_(files) {
    return !this.isPathConflict_(files);
  }

  isPathConflict_(files) {
    const destToSrcPaths = new Map();
    for (const file of files) {
      const destPath = file.jekyllMetadata.path;
      if (!destPath) {
        continue;
      }

      if (destToSrcPaths.has(destPath)) {
        reporter.fileDestinationConflict(destPath, destToSrcPaths.get(destPath), file.path);
        return true;
      } else {
        destToSrcPaths.set(destPath, file.path);
      }
    }

    return false;
  }

  prepareFiles_(files) {
    const srcPathsToFiles = this.files.reduce((accMap, file) => {
      accMap.set(file.path, file);
      if (file.virtualSourcePath) {
        accMap.set(path.join(this.repoPath, file.virtualSourcePath), file);
      }
      return accMap;
    }, new Map());
    this.files.forEach((file) => this.prepareFile_(file));
    this.files.forEach((file) => rewriteLocalLinks(file, this, srcPathsToFiles));
  }

  prepareFile_(file) {
    const fileMetadata = file.jekyllMetadata;
    if (!fileMetadata.path) {
      reporter.fileWarning(file.path, 'Cannot copy. No path metadata defined.');
      return;
    }

    file.prepareForDocSite();

    this.applyPathRemapping_(file, fileMetadata.path);
    file.path = path.resolve(path.join(BuildDir.STAGE, this.basepath), file.relative);
    file.base = BuildDir.STAGE;
  }

  applyPathRemapping_(file, destPath) {
    if (destPath.endsWith('/')) {
      destPath += 'index.md';
    } else if (destPath.endsWith('.html')) {
      destPath = destPath.replace(/(.*)\.html$/, '$1.md');
    }

    file.base = '/';
    file.path = destPath;
  }

  buildNavigation_(filesBySection) {
    for (const [section, sectionFiles] of filesBySection) {
      const sectionNav = new SectionNavigation(section, sectionFiles, this.basepath);
      const navItems = this.tweakNavigation_(sectionNav);

      // Now that we've constructed the navigation for this section, we write
      // it out to every file in the section that hasn't defined their own.
      for (const file of sectionFiles) {
        const metadata = file.jekyllMetadata;
        if (file.navigation) {
          continue;
        }

        metadata.navigation = navItems;
      }
    }
  }

  tweakNavigation_(sectionNav) {
    // TODO(shyndman): This is gross. Much better defined as part of the site's
    // configuration.
    switch (sectionNav.name) {
      case 'components':
      case 'docs':
        return sectionNav.items[0].children;

      default:
        return sectionNav.items;
    }
  }
}


function readYaml(yamlPath) {
  return yaml.safeLoad(fs.readFileSync(yamlPath));
}


module.exports = {
  PlatformSite,
};
