/*
 * grunt-electron-app-builder
 * https://github.com/speak/grunt-electron-app-builder
 *
 * Copyright (c) 2014 Chad Fawcett
 *
 * Licensed under the Apache 2.0 license.
 */

var path = require('path');
var fs = require('fs-extra');
var request = require('request');
var async = require('async');
var wrench = require('wrench');
var decompressZip = require('decompress-zip');
var progress = require('progress');
var _ = require('lodash');

module.exports = function(grunt) {

    grunt.registerTask(
        'build-electron-app',
        'Package the app as an electron application',
        function() {
            var plat
            if(process.platform == 'linux') {
                plat = 'linux' + process.arch.replace('x', '').replace('ia', '');
            } else {
                plat = process.platform;
            }
            var done = this.async();
            var options = this.options({
                electron_version: null,
                build_dir: "build",
                cache_dir: "cache",
                app_dir: "app",
                force_cached_version: false,
                platforms: [plat]
            });

            options.platforms.forEach(function(platform){
                var supportedPlatforms = ['darwin','win32','linux','linux32','linux64'];
                if (supportedPlatforms.indexOf(platform) == -1) {
                    grunt.log.warn('Unsupported platform: [' + platform + ']');
                }
            });

            if (options.platforms.indexOf('linux') >= 0 && options.platforms.indexOf('linux32') >= 0) {
                grunt.log.warn("linux32 and linux are equivalent, but you're trying to build both. Removed 'linux' from the target platforms.")
                options.platforms.splice(options.platforms.indexOf('linux'), 1);
            }

            if ((process.platform == 'win32') && options.platforms.indexOf('darwin') != -1) {
                grunt.log.warn("Due to symlinks in the electron zip, darwin builds are not supported on Windows and will be skipped.");
                options.platforms.splice(options.platforms.indexOf('darwin'), 1);
            }

            async.waterfall([
                function(callback) {
                    getLatestTagIfNeeded(options, callback);
                },
                verifyTagAndGetReleaseInfo,
                downloadReleases,
                extractReleases,
                removeDefaultApp,
                addAppSources,
                setLinuxPermissions,
            ], function(err) { if (err) throw err; done(); }

        );
    });


    function setLinuxPermissions(options, callback) {
        async.eachSeries(options.platforms, function(platform, localcallback) {
          if (['linux', 'linux32', 'linux64'].indexOf(platform) != -1 && process.platform == 'linux') {
              var p = path.join(options.build_dir, platform, "electron", "resources", "app")
            
              if(fs.existsSync(p)) {
                grunt.log.success("app dir exists");
                fs.chmodSync(p, 0755);
              }

              if(fs.existsSync(p+".asar")) {
                grunt.log.success("app archive exists");
                fs.chmodSync(p+".asar", 0755);
              }
              
              if(fs.existsSync(p+".asar.unpacked")) {
                grunt.log.success("app unpacked dir exists");
                fs.chmodSync(p+".asar.unpacked", 0755);
              }

              fs.chmodSync(path.join(options.build_dir, platform, "electron", "electron"), 0757)
          }
          localcallback(null)
        });
        callback();
    }

    function addArchitectureToPlatform(platform)
    {
        if (platform === 'darwin')
        {
            platform = 'darwin-x64';
        }
        else if (platform === 'win32' || platform === 'linux')
        {
            platform = platform + '-ia32';
        }
        else if (platform === 'linux32') {
            platform = 'linux-ia32';
        }
        else if (platform === 'linux64') {
            platform = 'linux-x64';
        }
        return platform;
    }

    function getLatestTagIfNeeded(options, callback)
    {
        if (options.electron_version)
            callback(null, options, null);
        else
        {
            request({
                    url: 'https://api.github.com/repos/atom/electron/releases',
                    json: true,
                    headers: {
                        'User-Agent': "grunt-electron-app-builder",
                        'Authorization': options.Authorization ? options.Authorization : ''
                    }
                }
                , function(error, response, body) {
                    if (error)
                        callback(error);
                    if (response.statusCode == 403)
                        callback(new Error("github API unexpected response in getLatestTagIfNeeded() with HTTP response code of " + response.statusCode + '. Probably hit the throttle limit.'));
                    if (response.statusCode != 200)
                        callback(new Error("github API unexpected response in getLatestTagIfNeeded() with HTTP response code of " + response.statusCode));

                    var releaseInfo = _.find(body, {'prerelease' : false });
                    options.electron_version = releaseInfo.tag_name;
                    callback(null, options, body);
                }
            );
        }
    }

    function verifyTagAndGetReleaseInfo(options, responseBody, callback)
    {
        var cachedReleaseInfoFile = path.join(options.cache_dir, 'package-info-'+options.electron_version+'.json');
        var cachedReleaseInfo;
        
        if (responseBody)
        {
            var releaseInfo = _.find(responseBody, {'tag_name' : options.electron_version });
            if (!releaseInfo)
            {
                callback(new Error("Could not find a release with tag " + options.electron_version));
            }
            callback(null, options, releaseInfo);
        }
        else
        {
            try {
                cachedReleaseInfo = grunt.file.readJSON(cachedReleaseInfoFile);
                grunt.log.writeln("Cached release info found...");
            } catch(e) {
                // could not find release info
            }
          
            if (cachedReleaseInfo) {
                callback(null, options, cachedReleaseInfo);
            } else {
                request({
                        url: 'https://api.github.com/repos/atom/electron/releases',
                        json: true,
                        headers: {
                            'User-Agent': "grunt-electron-app-builder",
                            'Authorization': options.Authorization ? options.Authorization : ''
                        }
                    }
                    , function(error, response, body) {
                        if (error)
                            callback(error);
                        if (response.statusCode == 403)
                            callback(new Error("github API unexpected response in verifyTag() with HTTP response code of " + response.statusCode + '. Probably hit the throttle limit.'));
                        if (response.statusCode != 200)
                            callback(new Error("github API unexpected response in verifyTag() with HTTP response code of " + response.statusCode));

                        var releaseInfo = _.find(body, {'tag_name' : options.electron_version });
                        if (!releaseInfo)
                        {
                            callback(new Error("Could not find a release with tag " + options.electron_version));
                        }
                    
                        grunt.file.write(cachedReleaseInfoFile, JSON.stringify(releaseInfo));
                        callback(null, options, releaseInfo);
                    }
                );
            } 
        }
    }

    function downloadReleases(options, releaseInfo, callback)
    {
        grunt.log.subhead("Downloading releases...")
        wrench.mkdirSyncRecursive(options.cache_dir);
        async.eachSeries(options.platforms,
            function(platform, localcallback) {
                downloadIndividualRelease(options, releaseInfo, platform, localcallback);
            }, function(err) { callback(err,options); }
        );
    }

    function downloadIndividualRelease(options, releaseInfo, platform, callback)
    {
        var assetName = "electron-" + options.electron_version + "-" + addArchitectureToPlatform(platform) + ".zip";
        var foundAsset = _.find(releaseInfo.assets, {'name' : assetName });

        if (!foundAsset) {
            grunt.log.writeln("Asset not found: " + assetName);
            grunt.log.writeln("Available assets:");

            releaseInfo.assets.forEach(function (asset) {
                grunt.log.writeln("\t" + asset.name);
            });

            throw new Error("Failed to find asset: " + assetName);
        }

        var assetUrl = foundAsset.url;
        var assetSize = foundAsset.size;
        var saveLocation = path.join(options.cache_dir,assetName);

        if (fs.existsSync(saveLocation))
        {
            var stats = fs.statSync(saveLocation);
            if (options.force_cached_version || (stats.isFile() && (stats.size == assetSize)))
            {
                grunt.log.ok(" Found cached download of " + assetName);
                callback();
                return;
            }
        }
        grunt.log.writeln(" Downloading electron for " + platform);
        var bar;
        request({
                url: assetUrl,
                headers: {
                    'User-Agent': "grunt-electron-app-builder",
                    "Accept" : "application/octet-stream",
                    'Authorization': options.Authorization ? options.Authorization : ''
                }
            }).on('end', function() {
                    callback();
            }).on('response', function(response) {
                bar = new progress('  [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 20,
                    total: parseInt(response.headers['content-length'])
                });
            }).on('data', function(chunk) {
                bar.tick(chunk.length);
            }).pipe(fs.createWriteStream(saveLocation));
    }

    function extractReleases(options, callback)
    {
        grunt.log.subhead("Extracting releases...")
        async.eachSeries(options.platforms,
            function(platform, localcallback) {
                grunt.log.ok("Extracting " + platform);
                wrench.rmdirSyncRecursive(path.join(options.build_dir, platform, "electron"), true);
                wrench.mkdirSyncRecursive(path.join(options.build_dir, platform));
                var zipPath = path.join(options.cache_dir, "electron-" + options.electron_version + "-" + addArchitectureToPlatform(platform) + ".zip");
                var destPath = path.join(options.build_dir, platform, "electron");
                if (process.platform != 'win32' && platform == 'darwin')
                {
                    spawn = require('child_process').spawn;
                    zip = spawn('unzip',['-qq','-o', zipPath, '-d', destPath]);
                    zip.on('exit', function(code) {
                        localcallback(null);
                    });
                    zip.stdout.on('data', function(data) { });
                    zip.stderr.on('data', function(data) { });
                    zip.on('error', function(err){
                        grunt.log.error(err);
                        localcallback(err);
                    });
                }
                else
                {
                    var unzipper = new decompressZip(zipPath);
                    unzipper.on('error', function(err) {
                        grunt.log.error(err);
                        localcallback(err);
                    });
                    unzipper.on('extract', function(log){
                        localcallback();
                    });
                    unzipper.extract({
                        path: destPath
                    });
                }

            }, function(err) { callback(err,options); }
        );
    }

    //
    // Return if the requested platform contain 'platform' as a sub-string.
    //
    function isPlatformRequested(requestedPlatform, platform) {
        return requestedPlatform.indexOf(platform) != -1;
    }
    
    function removeDefaultApp(options, callback)
    {
        grunt.log.subhead("Removing default_app.")
      
        options.platforms.forEach(function (requestedPlatform) {
          var buildOutputDir = path.join(options.build_dir, requestedPlatform, "electron");
          var defaultApp = path.join(buildOutputDir, "resources", "default_app");

          if (isPlatformRequested(requestedPlatform, "darwin")) {
              defaultApp = path.join(buildOutputDir, "Electron.app", "Contents","Resources", "default_app");
          }

          if (fs.existsSync(defaultApp)) {
            fs.remove(defaultApp, function (err) {
              if (err) return grunt.log.fail(err);
              callback(err, options);
            });
          } else {
            callback(null, options);
          }
        });
    }

    function addAppSources(options, callback)
    {
        grunt.log.subhead("Adding app to releases.")

        options.platforms.forEach(function (requestedPlatform) {

            var buildOutputDir = path.join(options.build_dir, requestedPlatform, "electron");
            var appOutputDir;

            if (isPlatformRequested(requestedPlatform, "darwin")) {
                appOutputDir = path.join(buildOutputDir, "Electron.app", "Contents","Resources", "app");
            }
            else if (isPlatformRequested(requestedPlatform, "win32") ||
                     isPlatformRequested(requestedPlatform, "linux")) {

                appOutputDir = path.join(buildOutputDir, "resources", "app");
            }
            else {
                grunt.log.fail("Failed to copy app, platform not understood: " + requestedPlatform);
            }

            var appDirStats = fs.lstatSync(options.app_dir);

            if(appDirStats.isDirectory()) {
              grunt.log.ok("App is a directory")
              wrench.copyDirSyncRecursive(options.app_dir, appOutputDir, {
                  forceDelete: true,
                  excludeHiddenUnix: true,
                  preserveFiles: false,
                  preserveTimestamps: true,
                  inflateSymlinks: true
              });
            } else if (appDirStats.isFile() && options.app_dir.indexOf('.asar') !== -1) {
              grunt.log.ok("App is packed as .asar")
              fs.copySync(options.app_dir, appOutputDir+'.asar');
              
              if (fs.existsSync(options.app_dir + ".unpacked")) {
                fs.copySync(options.app_dir + ".unpacked", appOutputDir+'.asar.unpacked');
              }
            } else {
              grunt.log.error('Shared directory must be either a directory or an ASAR archive.')
            }

            grunt.log.ok("Build for platform " + requestedPlatform + " located at " + buildOutputDir);
        });

        callback(null, options);
    }
};
