/*
 * grunt-atom-shell-app-builder
 * https://github.com/entropi/grunt-atom-shell-app-builder
 *
 * Copyright (c) 2014 Chad Fawcett
 * 
 * Licensed under the Apache 2.0 license.
 */

var path = require('path');
var fs = require('fs');
var request = require('request');
var async = require('async');
var wrench = require('wrench');
var decompressZip = require('decompress-zip');
var progress = require('progress');
var _ = require('lodash');

module.exports = function(grunt) {

	grunt.registerTask(
		'build-atom-shell-app',
		'Package the app as an atom-shell application',
		function() {
			var done = this.async();
			var options = this.options({
				atom_shell_version: null,
				build_dir: "build",
				cache_dir: "cache",
				app_dir: "app",
				platforms: [process.platform]
      		});

			var unsupported = false;
			options.platforms.forEach(function(platform){
				var supportedPlatforms = ['darwin','win32','linux'];
				if (supportedPlatforms.indexOf(platform) == -1) {
					grunt.log.error('Unsupported platform: [' + platform + ']');
					unsupported = true;
				}
			});
			if (unsupported) done(false);

			if ((process.platform == 'win32') && options.platforms.indexOf('darwin') != -1) {
				grunt.log.warn("Due to symlinks in the atom-shell zip, darwin builds are not supported on Windows and will be skipped.");
				options.platforms.splice(options.platforms.indexOf('darwin'), 1);
			}

			async.waterfall([
				function(callback) {
					getLatestTagIfNeeded(options, callback);
				},
				verifyTagAndGetReleaseInfo,
				downloadReleases,
				extractReleases,
				addAppSources
			], function(err) { if (err) throw err; done(); }
      	);
    });

	function getLatestTagIfNeeded(options, callback)
	{
		if (options.atom_shell_version)
			callback(null, options, null);
		else
		{
			request({
					url: 'https://api.github.com/repos/atom/atom-shell/releases',
					json: true,
					headers: {
						'User-Agent': "grunt-atom-shell-app-builder"
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
	    			options.atom_shell_version = releaseInfo.tag_name;
	    			callback(null, options, body);
	    		}
			);
		}
	}

	function verifyTagAndGetReleaseInfo(options, responseBody, callback)
	{
		if (responseBody)
		{
			var releaseInfo = _.find(responseBody, {'tag_name' : options.atom_shell_version });
			if (!releaseInfo)
			{
				callback(new Error("Could not find a release with tag " + options.atom_shell_version));
			}
			callback(null, options, releaseInfo);
		}
		else
		{
			request({
					url: 'https://api.github.com/repos/atom/atom-shell/releases',
					json: true,
					headers: {
						'User-Agent': "grunt-atom-shell-app-builder"
					}
	   			}
				, function(error, response, body) {
					if (error)
						callback(error);
					if (response.statusCode == 403)
						callback(new Error("github API unexpected response in verifyTag() with HTTP response code of " + response.statusCode + '. Probably hit the throttle limit.'));
					if (response.statusCode != 200)
						callback(new Error("github API unexpected response in verifyTag() with HTTP response code of " + response.statusCode));

					var releaseInfo = _.find(body, {'tag_name' : options.atom_shell_version });
					if (!releaseInfo)
					{
						callback(new Error("Could not find a release with tag " + options.atom_shell_version));
					}
					callback(null, options, releaseInfo);
				}
			);
		}
	}

	function downloadReleases(options, releaseInfo, callback)
	{
		grunt.log.subhead("Downloading releases...")
		options.platforms.forEach(function(platform) {
			wrench.mkdirSyncRecursive(options.cache_dir);	
		});
		async.eachSeries(options.platforms, 
			function(platform, localcallback) {
				downloadIndividualRelease(options, releaseInfo, platform, localcallback);
			}, function(err) { callback(err,options); }
		);
	}

	function downloadIndividualRelease(options, releaseInfo, platform, callback)
	{
		var assetName = "atom-shell-" + options.atom_shell_version + "-" + platform + ".zip";
		var assetUrl = _.find(releaseInfo.assets, {'name' : assetName }).url;
		var assetSize = _.find(releaseInfo.assets, {'name' : assetName }).size;
		var saveLocation = path.join(options.cache_dir,assetName);
		
		if (fs.existsSync(saveLocation))
		{
			var stats = fs.statSync(saveLocation);
			if (stats.isFile() && (stats.size == assetSize))
			{
				grunt.log.ok(" Found cached download of " + assetName);
				callback();
				return;
			}
		}
		grunt.log.writeln(" Downloading atom-shell for " + platform);
		var bar;
		request({
				url: assetUrl,
				headers: {
					'User-Agent': "grunt-atom-shell-app-builder",
					"Accept" : "application/octet-stream"
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
				wrench.rmdirSyncRecursive(path.join(options.build_dir, platform, "atom-shell"), true);
				wrench.mkdirSyncRecursive(path.join(options.build_dir, platform));
				var zipPath = path.join(options.cache_dir, "atom-shell-" + options.atom_shell_version + "-" + platform + ".zip");
				var destPath = path.join(options.build_dir, platform, "atom-shell");
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

	function addAppSources(options, callback)
	{
		grunt.log.subhead("Adding app to releases.")
		if (options.platforms.indexOf("darwin") != -1)
		{
			wrench.copyDirSyncRecursive(options.app_dir, path.join(options.build_dir, "darwin", "atom-shell", "Atom.app", "Contents","Resources", "app"), {
				forceDelete: true, 
				excludeHiddenUnix: true,
				preserveFiles: false,
				preserveTimestamps: true,
				inflateSymlinks: true
			});
			grunt.log.ok("OS X build located at " + path.join(options.build_dir, "darwin", "atom-shell"));
		}
		if (options.platforms.indexOf("win32") != -1)
		{
			wrench.copyDirSyncRecursive(options.app_dir, path.join(options.build_dir, "win32", "atom-shell", "resources", "app"), {
				forceDelete: true, 
				excludeHiddenUnix: true,
				preserveFiles: false,
				preserveTimestamps: true,
				inflateSymlinks: true
			});
			grunt.log.ok("Windows build located at " + path.join(options.build_dir, "win32", "atom-shell"));
		}
		if (options.platforms.indexOf("linux") != -1)
		{
			wrench.copyDirSyncRecursive(options.app_dir, path.join(options.build_dir, "linux", "atom-shell", "resources", "app"), {
				forceDelete: true, 
				excludeHiddenUnix: true,
				preserveFiles: false,
				preserveTimestamps: true,
				inflateSymlinks: true
			});
			grunt.log.ok("Linux build located at " + path.join(options.build_dir, "linux", "atom-shell"));

		}

	}
};

