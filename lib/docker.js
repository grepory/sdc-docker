/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * docker.js
 */

var adminEndpoints = require('./endpoints/admin');
var assert = require('assert-plus');
var bunyan = require('bunyan');
var common = require('./common');
var endpoints = require('./endpoints');
var fs = require('fs');
var hijack = require('./hijack');
var models = require('./models');
var moray = require('moray');
var wfapi = require('./wfapi');
var registry = require('docker-registry-client');
var os = require('os');
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');
var verror = require('verror');



//---- globals

var VERSION = JSON.parse(fs.readFileSync(path.normalize(
    __dirname + '/../package.json'), 'utf8')).version;



//---- internal support stuff

function loadConfigSync(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var configPath = path.resolve(__dirname, '..', 'etc', 'config.json');
    opts.log.info('Loading config from "%s"', configPath);
    var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Validation. XXX backend-specific config validation should not be here.
    assert.number(config.port, 'config.port');
    assert.string(config.defaultPackage, 'config.defaultPackage');
    assert.string(config.logLevel, 'config.logLevel');
    assert.object(config.cnapi, 'config.cnapi');
    assert.string(config.cnapi.url, 'config.cnapi.url');
    assert.object(config.imgapi, 'config.imgapi');
    assert.string(config.imgapi.url, 'config.imgapi.url');
    assert.object(config.napi, 'config.napi');
    assert.string(config.napi.url, 'config.papi.url');
    assert.object(config.papi, 'config.napi');
    assert.string(config.papi.url, 'config.papi.url');
    assert.object(config.vmapi, 'config.vmapi');
    assert.string(config.vmapi.url, 'config.vmapi.url');

    return config;
}



//---- the App

function App(opts) {
    var self = this;
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.config, 'opts.config');

    self.version = VERSION;
    self.log = opts.log;
    self.config = opts.config;

    var Backend = require('./backends/' + self.config.backend);
    self.backend = new Backend({log: self.log, config: self.config});

    self.indexClient = registry.createIndexClient({
        log: self.log.child({ registry: true }, true),
        url: self.config.registry.indexUrl
    });

    self.wfapi = new wfapi(self.config.wfapi, self.log);
    self.wfapi.connect(function () {
        self.log.info('wfapi is ready');
    });

    self.createMorayClient();

    // Simple object to keep a list of commands that have been queued with
    // docker exec. Each command points to an address where a TCP socket is
    // listening. The socket dies after 5 seconds
    self.execCommands = {};

    // Docker has two types of resizes: one is indexed by exec id and the
    // other one is indexed by container id. In this object we store a reference
    // from container id to a resize object (rows/columns) because resize is
    // called before attach. When /attach is finally called, we send a resize
    // command to the socket before the actual attach raw data communication
    // happens. This object is only valid when we are attaching to a container
    // in TTY mode
    self.containerResizes = {};

    // TODO one cache store to hold execCommands and a list of pulls and other
    // commands that are being executed and need to report progress
    self.operations = {};

    var server = self.server = restify.createServer({
        log: opts.log,
        name: 'docker',
        version: self.version
    });

    server.on('connection', function (socket) {
        hijack.hijack({
            socket: socket,
            log: opts.log
        });
    });

    server.on('upgrade', function (oldreq, socket, body) {
        socket.unshift(body);
        self.log.info('Socket has been hijacked');
    });

    server.use(function (req, res, next) {
        // Headers we want for all responses.
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
        });

        req.app = self;
        req.backend = self.backend;
        req.indexClient = self.indexClient;
        req.wfapi = self.wfapi;

        next();
    });

    server.use(restify.requestLogger());
    server.use(restify.queryParser({mapParams: false}));
    server.use(restify.bodyParser());
    server.on('after', common.filteredAuditLog);
    server.on('uncaughtException', common.uncaughtHandler);
    endpoints.register(server, opts.log, [
        common.checkServices,
        common.checkApiVersion
    ]);

    self.setupAdminSever();
}

App.prototype.setupAdminSever = function listen(callback) {
    var self = this;
    var admin = self.admin = restify.createServer({
        log: self.log,
        name: 'docker-admin',
        version: self.version
    });

    admin.use(function (req, res, next) {
        // Headers we want for all responses.
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
        });

        req.app = self;
        req.backend = self.backend;

        next();
    });

    admin.use(restify.requestLogger());
    admin.use(restify.queryParser({mapParams: false}));
    admin.use(restify.bodyParser());
    admin.on('after', common.filteredAuditLog);
    admin.on('uncaughtException', common.uncaughtHandler);
    adminEndpoints.register(admin, self.log, [ common.checkServices ]);
};

App.prototype.listen = function (callback) {
    var self = this;
    var adminIp = self.getAdminIp();

    vasync.pipeline({
        funcs: [
            function startPublicServer(_, next) {
                self.server.listen(self.config.port, next);
            },
            function startAdminServer(_, next) {
                self.admin.listen(80, adminIp, next);
            }
        ]
    }, function (err, results) {
        if (err) {
            self.log.error(err, 'Error starting server');
        } else {
            var addr = self.server.address();
            var adminAddr = self.admin.address();
            self.log.info('Started docker.js on <http://%s:%s>',
                addr.address, addr.port);
            self.log.info('Started admin server on <http://%s:%s>',
                adminAddr.address, adminAddr.port);
        }
    });
};

App.prototype.close = function close(callback) {
    this.server.on('close', function () {
        callback();
    });
    this.server.close();
};

/**
 * Creates a moray client, retrying as necessary
 */
App.prototype.createMorayClient = function createMorayClient() {
    var self = this;
    var conf = {
        connectTimeout: 1000,
        host: self.config.moray.host,
        noCache: true,
        port: self.config.moray.port,
        reconnect: true,
        retry: {
            retries: Infinity,
            maxTimeout: 6000,
            minTimeout: 100
        }
    };

    self.log.debug(conf, 'Creating moray client');
    conf.log = self.log.child({
        component: 'moray',
        level: self.config.moray.logLevel || 'info'
    });
    var client = moray.createClient(conf);

    function onMorayConnect() {
        client.removeListener('error', onMorayError);
        client.log.info('moray: connected');
        self.morayConnected = true;
        self.moray = client;
        self.initMoray();

        client.on('close', function () {
            client.log.error('moray: closed');
            self.morayConnected = false;
        });

        client.on('connect', function () {
            client.log.info('moray: reconnected');
            self.morayConnected = true;
        });

        client.on('error', function (err) {
            client.log.warn(err, 'moray: error (reconnecting)');
            self.morayConnected = false;
        });
    }

    function onMorayError(err) {
        client.removeListener('connect', onMorayConnect);
        self.morayConnected = false;
        client.log.error(err, 'moray: connection failed');
    }

    function onMorayConnectAttempt(number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }
        client.log[level]({
                attempt: number,
                delay: delay
        }, 'moray: connection attempted');
    }

    client.once('connect', onMorayConnect);
    client.once('error', onMorayError);
    client.on('connectAttempt', onMorayConnectAttempt); // this we always use
};

/*
 * Gets the admin IP address for the sdc-docker server
 */
App.prototype.getAdminIp = function () {
    var interfaces = os.networkInterfaces();
    var ip;
    var ifs = interfaces['net0'];

    assert.object(ifs, 'admin interface');

    for (var i = 0; i < ifs.length; i++) {
        if (ifs[i].family === 'IPv4') {
            ip = ifs[i].address;
            break;
        }
    }

    return ip;
};


/**
 * Initializes moray buckets
 */
App.prototype.initMoray = function () {
    var self = this;
    var att = 1;
    var timeout = null;

    function modelInitRetry() {
        models.init(self, function (err) {
            if (timeout) {
                clearTimeout(timeout);
            }

            if (!err) {
                self.log.info('models initialized');
                return;
            }

            self.log.error(err, 'Error initializing models (attempt=%d)', att);
            att++;
            timeout = setTimeout(modelInitRetry, 10000);
        });
    }

    modelInitRetry();
};



//---- mainline

function main() {
    var log = bunyan.createLogger({
        name: 'docker',
        level: 'debug',
        serializers: restify.bunyan.serializers
    });

    var config = loadConfigSync({log: log});
    log.level(config.logLevel);

    var app = new App({log: log, config: config});
    app.listen();
}

main();
