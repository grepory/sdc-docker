/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');
var vasync = require('vasync');
var registry = require('docker-registry-client');
var mod_url = require('url');
var format = require('util').format;
var fs = require('fs');

var common = require('../common');
var writeProgress = common.writeProgress;
var writeStatus = common.writeStatus;

/**
 * GET /images/json
 */
function imageList(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;
    options.all = (req.query.all === 1 || req.query.all === '1');

    req.backend.listImages(options, function (err, images) {

        log.debug({query: req.query}, 'got query');

        if (err) {
            log.error({err: err}, 'Problem loading images');
            next(new restify.InternalError('Problem loading images'));
            return;
        }

        res.send(images);
        next();
    });
}


/**
 * POST /images/create
 *
 * TODO actual validation: check image data on moray
 * TODO error handling
 */
function imageCreate(req, res, next) {
    var log = req.log;
    var parsed;

    // The docker client will always pass a tag unless the intention is to pull
    // all tags for a given repository. In that case parsed.tag might
    // default to 'latest' if fromImage is just ubuntu
    var askedTag = req.query.tag
                    || req.query.fromImage.split(':')[1] || 'all';

    try {
        parsed = registry.parseRepoAndTag(req.query.fromImage);
    } catch (err) {
        log.error({err: err}, 'imageCreate error');
        next(new restify.InternalError('imageCreate error'));
        return;
    }

    res.status(200);
    res.header('Content-Type', 'application/json');

    req.backend.pullImage({
        app: req.app,
        askedTag: askedTag,
        log: log,
        parsed: parsed,
        req_id: req.getId(),
        res: res,
        wfapi: req.wfapi
    }, function (err) {
        if (err) {
            next(err);
            return;
        }

        res.end();
        next(false);
    });
}


/**
 * GET /images/:name/json
 *
 * Images can be inspected by name[:tag] or id
 */
function imageInspect(req, res, next) {
    var name = req.params.name;
    var log = req.log;
    var parsed;

    req.log.debug({req: req}, 'req');

    // When an imgId is passed, parsed.name will be the imgId string
    // that we will match in the DockerImage query
    try {
        parsed = registry.parseRepoAndTag(name);
    } catch (err) {
        log.error({err: err}, 'imageInspect error');
        next(new restify.InternalError('imageInspect error'));
        return;
    }

    req.backend.inspectImage({
        app: req.app,
        parsed: parsed,
        log: log
    }, function (err, image) {

        if (err) {
            log.error({err: err}, 'backend.imageInspect failed.');
            next(err);
            return;
        }

        res.send(image);
        next();
    });
}


/**
 * GET /images/:name/history
 */
function imageHistory(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;

    var history = [];

    try {
        options.parsed = registry.parseRepoAndTag(req.params.name);
    } catch (err) {
        log.error({err: err}, 'imageHistory error');
        next(new restify.InternalError('imageHistory error'));
        return;
    }

    // TODO move all of this to backend
    req.backend.getImageAncestry(options, function (err, ancestry) {
        if (err) {
            next(err);
            return;
        }

        ancestry = ancestry.reverse();
        vasync.forEachPipeline({
            func: getLayerHistory,
            inputs: ancestry
        }, function (pipeErr) {
            if (pipeErr) {
                next(pipeErr);
                return;
            }

            res.send(history.reverse());
            next();
        });
    });

    function getLayerHistory(imgId, cb) {
        options.docker_id = imgId;
        req.backend.getImage(options, function (err, image) {
            if (err) {
                cb(err);
                return;
            }

            var createdBy = '';
            if (image.container_config && image.container_config.Cmd) {
                createdBy = image.container_config.Cmd.join(' ');
            }
            var created = Math.floor((new Date(image.created))
                                .getTime() / 1000);

            history.push({
                Id: imgId,
                Created: created,
                CreatedBy: createdBy || '',
                Size: image.size
            });
            cb();
        });
    }
}


/**
 * POST /images/:name/push
 */
function imagePush(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/changes
 */
function imageChanges(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/tag
 */
function imageTag(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * DELETE /images/:name
 */
function imageDelete(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;

    try {
        options.parsed = registry.parseRepoAndTag(req.params.name);
    } catch (err) {
        log.error({err: err}, 'imageHistory error');
        next(new restify.InternalError('imageHistory error'));
        return;
    }

    req.backend.deleteImage(options, function (err, history) {
        if (err) {
            next(err);
            return;
        }

        res.send(history);
        next();
    });
}


/**
 * GET /images/search
 */
function imageSearch(req, res, next) {
    var term = req.query.term;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.indexClient.search({
        term: term,
        log: log
    }, function (err, images) {
        if (err) {
            log.error({err: err}, 'registry.search failed.');
            next(err);
            return;
        }

        res.send(images.results);
        next();
    });
}


/**
 * GET /images/:name/get
 */
function imageGet(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /images/:name/load
 */
function imageLoad(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}




/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/:apiversion/images/json', name: 'ImageList' },
        before, imageList);
    http.post({ path: '/:apiversion/images/create', name: 'ImageCreate' },
            before, imageCreate);
    http.get({ path: '/:apiversion/images/:name/json', name: 'ImageInspect' },
        before, imageInspect);
    http.get({ path: '/:apiversion/images/:name/history',
        name: 'ImageHistory' }, before, imageHistory);
    http.post({ path: '/:apiversion/images/:name/push', name: 'ImagePush' },
        before, imagePush);
    http.post({ path: '/:apiversion/images/:name/tag', name: 'ImageTag' },
        before, imageTag);
    http.del({ path: '/:apiversion/images/:name', name: 'ImageDelete' },
        before, imageDelete);
    http.get({ path: '/:apiversion/images/search', name: 'ImageSearch' },
        before, imageSearch);
    http.get({ path: '/:apiversion/images/:name/get', name: 'ImageGet' },
        before, imageGet);
    http.post({ path: '/:apiversion/images/:name/load', name: 'ImageLoad' },
        before, imageLoad);
}



module.exports = {
    register: register
};
