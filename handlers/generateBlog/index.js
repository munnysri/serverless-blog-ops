/*
  Copyright 2017 Linux Academy

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
 */

const async = require('async');
const AWS = require('aws-sdk');
const find = require('find');
const fs = require('fs');
const ghRequestParams = require('./githubRequestParams');
const ghResponse = require('./githubResponse');
const https = require('https');
const mime = require('mime');
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');

const s3 = new AWS.S3();

const buildSite = dir => new Promise((resolve, reject) => {
  const source = path.join(dir, 'src');
  const dest = path.join(dir, 'public');
  const bin = path.join(__dirname, 'bin', 'hugo');
  const args = ['--theme=hugo_theme_robust', '-s', source, '-d', dest];
  const hugoProcess = spawn(bin, args);
  hugoProcess.on('close', code => (code === 0 ?
    resolve() :
    reject(new Error(`Hugo exited with code ${code}`))
  ));
  hugoProcess.stdout.on('data', data => console.log(`stdout:\n${data}`));
  hugoProcess.stderr.on('data', data => console.log(`stderr:\n${data}`));
});

const bucketExists = bucketName => s3.headBucket({
  Bucket: bucketName,
}).promise();

const createTmpDir = (dir, callback) => fs.mkdtemp(dir, callback);

const ensureDir = dir => new Promise((resolve, reject) =>
  fs.mkdir(dir, (err) => {
    if (err && err.code !== 'EEXIST') {
      return reject(err);
    }
    resolve();
  })
);

const loadTheme = themeDir => new Promise((resolve, reject) =>
  https.get(
    Object.assign(
      url.parse(
        'https://api.github.com/repos/dim0627/hugo_theme_robust/tarball/b8ce466'
      ),
      ghRequestParams
    ),
    res => ghResponse(res, themeDir)
      .then(() => fs.rename(
          path.join(themeDir, 'dim0627-hugo_theme_robust-b8ce466'),
          path.join(themeDir, 'hugo_theme_robust'),
          err => (err ? reject(err) : resolve())
      ))
  )
);

const moveArchiveDirToSrc = dir => new Promise((resolve, reject) =>
  fs.readdir(dir, (readErr, contents) => {
    if (readErr) {
      return reject(readErr);
    }

    const archiveDir = contents.find(entry => entry !== 'public');
    if (!archiveDir) {
      return reject(new Error('Archive failed to load'));
    }
    fs.rename(
      path.join(dir, archiveDir),
      path.join(dir, 'src'),
      mvErr => (mvErr ? reject(mvErr) : resolve())
    );
  })
);

const rollback = (err, bucketName) => s3.deleteBucket({
  Bucket: bucketName,
}).promise().then(() => Promise.resolve(err));

const setupBucket = bucketName => s3.createBucket({
  Bucket: bucketName,
  ACL: 'public-read',
}).promise();

const uploadSite = (bucket, dir) => {
  const publicDir = path.join(dir, 'public');
  return new Promise((resolve, reject) =>
    find.file(publicDir, files =>
      Promise.all(
        files.map(file =>
          s3.putObject({
            Bucket: bucket,
            Key: path.relative(publicDir, file),
            ACL: 'public-read',
            Body: fs.createReadStream(file),
            ContentType: mime.lookup(file),
            // TODO: Cache controls
          }).promise().then(
            () => console.log(`Wrote ${path.relative(publicDir, file)}`),
            (err) => {
              console.error(`Failed to write ${path.relative(publicDir, file)}`);
              console.error(JSON.stringify(err));
              return Promise.reject(err);
            }
          )
        )
      ).then(resolve, reject)
    )
  );
};

exports.handler = (event, context, awsCallback) => {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    return awsCallback(null, { statusCode: 400 });
  }
  console.log(JSON.stringify(body));

  // Name temp dir using username and repo name
  const dirPrefix = `/tmp/${body.repository.full_name.replace('/', '_')}`;

  // URL to a *.tar.gz of the repository that triggered this
  const opts = Object.assign(
    url.parse(
      body.repository.archive_url
        .replace('{archive_format}', 'tarball')
        .replace('{/ref}', '/master')
    ),
    ghRequestParams
  );

  // Make the temp dir and start our archive request at the same time
  async.auto({
    archive: callback => https.get(opts, res => callback(null, res)).on('error', callback),
    dir: callback => createTmpDir(dirPrefix, callback),
    pub: [
      'dir',
      (res, callback) => fs.mkdir(path.join(res.dir, 'public'), callback),
    ],
  }, (asyncErr, results) => {
    if (asyncErr) {
      return awsCallback(asyncErr);
    }

    const { archive, dir } = results;
    const bucketName = `${process.env.SITE_BUCKET}-${body.after}`;
    console.log(bucketName);

    // If we can successfully get a HEAD for this bucket, it's already out there
    // TODO: Move this check to top of handler
    const existsPromise = bucketExists(bucketName)
      .then(() => console.log('Bucket exists, no action'))
      .then(() => awsCallback(null, {
        statusCode: 204,
      }));

    // An error from existsPromise means we need to make this deploy
    const buildPromise = existsPromise
      .catch(() => ghResponse(archive, dir))
      .then(() => moveArchiveDirToSrc(dir))
      .then(() => ensureDir(path.join(dir, 'src', 'themes')))
      .then(() => loadTheme(path.join(dir, 'src', 'themes')))
      .then(() => buildSite(dir))
      .then(() => setupBucket(bucketName))
      .then(() => console.log('Set up bucket'))
      .then(() => uploadSite(bucketName, dir));

    buildPromise.then(() => awsCallback(null, { statusCode: 201 }));
    buildPromise.catch(err => console.error(err));
    buildPromise.catch(err => rollback(err, bucketName))
      .then(awsCallback, awsCallback);
  });
};
