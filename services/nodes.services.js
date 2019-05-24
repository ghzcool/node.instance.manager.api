const os = require('os');
const fs = require('fs');
const zipFolder = require('zip-folder');
const rimraf = require('rimraf');
const process = require('process');
const pidusage = require('pidusage');
const spawn = require('child_process').spawn;
const osUtils = require('os-utils');
const diskspace = require('diskspace');
const moment = require('moment');
const ExpressRESTService = require("express-rest-service");
const decompress = require('decompress');

const Datastore = require('nedb');
const db = new Datastore({filename: './db/nodes.db', autoload: true});

db.ensureIndex({fieldName: '_id', unique: true}, function (error) {
    !!error && console.error(error);
});
db.ensureIndex({fieldName: 'name', unique: true}, function (error) {
    !!error && console.error(error);
});

const DATE_TIME_FORMAT = "YYYY-MM-DDTHH:mm:ss";
const MAX_OUTPUT_LENGTH = Number.MAX_VALUE;
const activeNodes = {};

const updateRecord = (query, update, service, callback) => {
    db.find(query, (error, records) => {
        const record = records[0];
        if (error || !record) {
            !!service && service.failure({
                status: 500,
                message: "Error getting database record",
                errors: [error]
            });
            !!callback && callback(null);
        }
        else {
            db.update(query, Object.assign({}, record, update), {
                multi: false,
                upsert: false,
                returnUpdatedDocs: false
            }, (error, data) => {
                if (error) {
                    !!service && service.failure({
                        status: 500,
                        message: "Error updating database record",
                        errors: [error]
                    });
                    !!callback && callback(null);
                }
                else {
                    !!service && service.success({data});
                    !!callback && callback(data);
                }
            });
        }
    });
};

const NodeCreate = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            name: true,
            executable: true,
            command: false,
            type: {
                type: "int",
                mandatory: true
            },
            env: "object"
        },
        fn: (service, request, response) => {
            const date = moment().format(DATE_TIME_FORMAT);
            db.insert({
                name: service.args.name,
                type: service.args.type,
                executable: service.args.executable,
                command: service.args.command || "",
                env: service.args.env,
                created: date,
                updated: date,
                started: null,
                stopped: null,
                start: false,
                error: false,
                output: null
            }, (error, record) => {
                if (error) {
                    service.failure({
                        status: 500,
                        message: "Error inserting into database",
                        errors: [error]
                    });
                }
                else {
                    const path = "./nodes/" + record._id;
                    if (!fs.existsSync(path)) {
                        fs.mkdirSync(path);
                    }
                    const data = Object.assign({}, record);
                    record.id = record._id;
                    delete record._id;
                    service.success({data});
                }
            });
        }
    }));
};

const NodesList = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            limit: "int",
            start: "int",
            sort: "string",
            desc: "boolean"
        },
        fn: (service, request, response) => {
            db.count({}, function (error, total) {
                if (error) {
                    service.failure({
                        status: 500,
                        message: "Error count from database",
                        errors: [error]
                    });
                }
                else {
                    const sort = {};
                    sort[service.args.sort || "created"] = !service.args.desc ? 1 : -1;
                    db.find({})
                        .sort(sort)
                        .skip(service.args.start || 0)
                        .limit(service.args.limit || 100)
                        .exec(function (error, records) {
                            if (error) {
                                service.failure({
                                    status: 500,
                                    message: "Error getting from database",
                                    errors: [error]
                                });
                            }
                            else {
                                const items = records.map(record => {
                                    return {
                                        name: record.name,
                                        type: record.type,
                                        executable: record.executable,
                                        command: record.command,
                                        env: record.env,
                                        created: record.created,
                                        updated: record.updated,
                                        id: record._id,
                                        started: record.started,
                                        stopped: record.stopped,
                                        start: record.start,
                                        error: record.error,
                                        output: record.output,
                                        stats: {}
                                    };
                                });

                                const stats = {};
                                let statRequests = 0;
                                let statResponses = 0;
                                const getStat = (id, activeNode) => {
                                    pidusage.stat(activeNode.pid, (error, stat) => {
                                        stats[id] = stat || {};
                                        statResponses++;
                                        if (statResponses === statRequests) {
                                            for (let i = 0; i < items.length; i++) {
                                                items[i].stats = stats[items[i].id] || {};
                                            }
                                            service.success({items, total});
                                        }
                                    });
                                };
                                for (let i = 0; i < items.length; i++) {
                                    const activeNode = activeNodes[items[i].id];
                                    if (activeNode) {
                                        statRequests++;
                                        getStat(items[i].id, activeNode);
                                    }
                                }
                                if (statRequests === 0) {
                                    service.success({items, total});
                                }
                            }
                        });
                }
            });
        }
    }));
};

const NodeUpdate = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            id: true,
            name: true,
            executable: true,
            command: false,
            type: {
                type: "int",
                mandatory: true
            },
            env: "object"
        },
        fn: (service, request, response) => {
            const date = moment().format(DATE_TIME_FORMAT);
            updateRecord({_id: service.args.id}, {
                name: service.args.name,
                type: service.args.type,
                executable: service.args.executable,
                command: service.args.command || "",
                env: service.args.env,
                updated: date
            }, service);
        }
    }));
};

const cutToMaxLength = (value, length) => {
    let newValue = String(value);
    if (!!length && length < newValue.length) {
        newValue = newValue.substr(Math.abs(length - newValue.length), length);
    }
    return newValue;
};

const NodeStart = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            id: true
        },
        fn: (service, request, response) => {
            const id = service.args.id;
            db.find({_id: id}, (error, records) => {
                if (error || !records[0]) {
                    service.failure({
                        status: 500,
                        message: "Error getting database record",
                        errors: [error]
                    });
                }
                else {
                    const record = records[0];
                    const path = "./nodes/" + id;

                    const executablesByType = {
                        1: "node",
                        2: "npm"
                    };

                    //run
                    activeNodes[id] = spawn(executablesByType[record.type], [record.executable].concat(!!record.command ? record.command.split(" ") : []), {
                        cwd: path,
                        env: Object.assign({}, process.env, record.env),
                        detached: false
                    });
                    const activeNode = activeNodes[id];

                    //listeners
                    activeNode.stdout.on('data', function (data) {
                        if (!activeNode.output) {
                            activeNode.output = "";
                        }
                        activeNode.output += String(data);
                        activeNode.output = cutToMaxLength(activeNode.output, MAX_OUTPUT_LENGTH);
                        const date = moment().format(DATE_TIME_FORMAT);
                        updateRecord({_id: id}, {
                            updated: date,
                            output: activeNode.output
                        });
                    });

                    activeNode.stderr.on('data', function (data) {
                        if (!activeNode.output) {
                            activeNode.output = "";
                        }
                        activeNode.output += String(data);
                        activeNode.output = cutToMaxLength(activeNode.output, MAX_OUTPUT_LENGTH);
                        activeNode.hasError = true;
                        const date = moment().format(DATE_TIME_FORMAT);
                        updateRecord({_id: id}, {
                            updated: date,
                            output: activeNode.output,
                            error: activeNode.hasError
                        });
                    });

                    activeNode.on('exit', function (code) {
                        if (!activeNode.output) {
                            activeNode.output = "";
                        }
                        activeNode.output += ('\nProcess closed with code ' + code + '\n');
                        activeNode.output = cutToMaxLength(activeNode.output, MAX_OUTPUT_LENGTH);
                        activeNode.hasError = true;
                        const date = moment().format(DATE_TIME_FORMAT);
                        activeNodes[id] = null;
                        updateRecord({_id: id}, {
                            updated: date,
                            started: null,
                            stopped: date,
                            output: activeNode.output,
                            error: activeNode.hasError
                        });
                    });

                    activeNode.on('error', function (error) {
                        if (!activeNode.output) {
                            activeNode.output = "";
                        }
                        activeNode.output += String(error);
                        activeNode.output = cutToMaxLength(activeNode.output, MAX_OUTPUT_LENGTH);
                        activeNode.hasError = true;
                        const date = moment().format(DATE_TIME_FORMAT);
                        updateRecord({_id: id}, {
                            updated: date,
                            output: activeNode.output,
                            error: activeNode.hasError
                        });
                    });

                    let timeout = setTimeout(()=> {
                        const date = moment().format(DATE_TIME_FORMAT);
                        updateRecord({_id: id}, {
                            start: true,
                            started: !!activeNode.hasError ? null : date,
                            stopped: !!activeNode.hasError ? date : null,
                            updated: date,
                            error: !!activeNode.hasError,
                            output: activeNode.output
                        }, service);
                    }, 1000);
                }
            });
        }
    }));
};

const NodeGet = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            id: true
        },
        fn: (service, request, response) => {
            db.find({_id: service.args.id}, (error, records) => {
                if (error) {
                    service.failure({
                        status: 500,
                        message: "Error getting database record",
                        errors: [error]
                    });
                }
                else {
                    const record = records[0];
                    const activeNode = activeNodes[service.args.id];
                    let stats = {};
                    const returnResult = () => {
                        const data = !!record ? {
                            name: record.name,
                            type: record.type,
                            executable: record.executable,
                            command: record.command,
                            env: record.env,
                            created: record.created,
                            updated: record.updated,
                            id: record._id,
                            started: record.started,
                            stopped: record.stopped,
                            start: record.start,
                            error: record.error,
                            output: record.output,
                            stats: stats
                        } : null;
                        service.success({data});
                    };
                    if (activeNode) {
                        pidusage.stat(activeNode.pid, (error, stat) => {
                            stats = stat || {};
                            returnResult();
                        });
                    }
                    else {
                        returnResult();
                    }
                }
            });
        }
    }));
};

const NodeStop = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            id: true
        },
        fn: (service, request, response) => {
            const activeNode = activeNodes[service.args.id];
            const date = moment().format(DATE_TIME_FORMAT);
            if (!!activeNode) {
                let withError = false;
                try {
                    process.kill(activeNode.pid, 'SIGTERM');
                    activeNodes[service.args.id] = null;
                }
                catch (e) {
                    withError = true;
                }
                updateRecord({_id: service.args.id}, {
                    start: false,
                    error: withError,
                    started: null,
                    stopped: date,
                    updated: date
                }, service);
            }
            else {
                updateRecord({_id: service.args.id}, {
                    start: false,
                    error: true,
                    started: null,
                    stopped: date,
                    updated: date
                }, service);
            }
        }
    }));
};

const NodeDelete = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            id: true
        },
        fn: (service, request, response) => {
            const activeNode = activeNodes[service.args.id];
            let withError = false;
            if (!!activeNode) {
                try {
                    process.kill(activeNode.pid, 'SIGTERM');
                    activeNodes[service.args.id] = null;
                }
                catch (e) {
                    withError = true;
                }
            }
            const path = "./nodes/" + service.args.id;
            db.remove({_id: service.args.id}, {multi: false}, (error, data)=> {
                if (fs.existsSync(path)) {
                    rimraf(path, () => {
                        if (error) {
                            service.failure({
                                status: 500,
                                message: "Error removing database record",
                                errors: [error]
                            });
                        }
                        else {
                            if (withError) {
                                service.failure({
                                    status: 500,
                                    message: "Error killing process",
                                    errors: []
                                });
                            }
                            else {
                                service.success({data});
                            }
                        }
                    });
                }
                else {
                    service.failure({
                        status: 500,
                        message: "Error deleting node directory",
                        errors: []
                    });
                }
            });
        }
    }));
};

const NodeTypesList = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {},
        fn: (service, request, response) => {
            const items = [
                {
                    id: "1",
                    name: "NodeJS"
                },
                {
                    id: "2",
                    name: "NPM"
                }
            ];
            const total = items.length;
            service.success({items, total});
        }
    }));
};

const SystemInfo = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {},
        fn: (service, request, response) => {
            let drive = "/";
            let tmp = __dirname.split(":\\");
            if (tmp.length > 1) {
                drive = tmp[0] + ":";
            }
            diskspace.check(drive, (error, space) => {
                if (!!error && Object.keys(error).length !== 0) {
                    service.failure({
                        status: 500,
                        message: "Error getting storage info",
                        errors: [error]
                    });
                }
                else {
                    osUtils.cpuUsage(cpuUsage => {
                        service.success({
                            data: {
                                space: space,
                                cpus: os.cpus(),
                                cpuUsage: cpuUsage,
                                freemem: os.freemem(),
                                loadavg: os.loadavg(),
                                totalmem: os.totalmem(),
                                uptime: process.uptime(),
                                networkInterfaces: os.networkInterfaces()
                            }
                        });
                    });
                }
            });
        }
    }));
};

const NodeUpload = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            token: true,
            id: true
        },
        fn: (service, request, response) => {
            if (!request.file) {
                service.failure({
                    status: 500,
                    message: "Error uploading file. No file.",
                    errors: []
                });
            }
            else if(!!activeNodes[service.args.id]) {
                service.failure({
                    status: 500,
                    message: "Error uploading file. Instance is running.",
                    errors: []
                });
            }
            else {
                db.find({_id: service.args.id}, (error, records) => {
                    const record = (records || [])[0];
                    if (error || !record) {
                        service.failure({
                            status: 500,
                            message: "Error getting database record",
                            errors: error ? [error] : []
                        });
                    }
                    else {
                        const path = "./nodes/" + record._id;
                        decompress(request.file.path, path).then(files => {
                            fs.unlinkSync(request.file.path);
                            service.success({data: 1});
                        });
                    }
                });
            }
        }
    }));
};

const NodeDownload = function (config) {
    return new ExpressRESTService(Object.assign({}, config, {
        args: {
            token: true,
            id: true
        },
        fn: (service, request, response) => {
            db.find({_id: service.args.id}, (error, records) => {
                const record = (records || [])[0];
                if (error || !record) {
                    service.failure({
                        status: 500,
                        message: "Error getting database record",
                        errors: error ? [error] : []
                    });
                }
                else {
                    const path = "./nodes/" + record._id;
                    const downloads = "./downloads";
                    const filename = record._id + ".zip";
                    const downloadPath = downloads + "/" + filename;
                    if (!fs.existsSync(downloads)) {
                        fs.mkdirSync(downloads);
                    }
                    zipFolder(path, downloadPath, function(error) {
                        if(error) {
                            service.failure({
                                status: 500,
                                message: "Error compressing node directory",
                                errors: error ? [error] : []
                            });
                        } else {
                            response.download(downloadPath, filename);
                        }
                    });
                }
            });
        }
    }));
};

const call = (classObject, query, callback) => {
    const classInstance = new classObject();
    classInstance.call({
        query: query || {},
        body: query || {}
    }, {
        writeHead: () => true,
        end: (stringified) => {
            const parsed = JSON.parse(stringified);
            !!callback && callback(parsed);
        }
    });
};

const init = () => {
    call(NodesList, {}, (response)=> {
        const items = response.items || [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.start) {
                call(NodeStart, {id: item.id});
            }
        }
    });
};

module.exports = {
    NodeCreate,
    NodesList,
    NodeGet,
    NodeUpdate,
    NodeDelete,
    NodeTypesList,
    SystemInfo,
    NodeStop,
    NodeStart,
    NodeUpload,
    NodeDownload,
    init
};
