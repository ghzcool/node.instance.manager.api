const moment = require('moment');
const sha256 = require('sha256');
const ExpressRESTService = require("express-rest-service");

const Datastore = require('nedb');
const db = new Datastore({filename: './db/users.db', autoload: true});

db.ensureIndex({fieldName: '_id', unique: true}, function (error) {
	!!error && console.error(error);
});
db.ensureIndex({fieldName: 'login', unique: true}, function (error) {
	!!error && console.error(error);
});
db.ensureIndex({fieldName: 'token', unique: true}, function (error) {
	!!error && console.error(error);
});

const DATE_TIME_FORMAT = "YYYY-MM-DDTHH:mm:ss";
const TOKEN_EXPIRATION_TIME = 60 * 20; //seconds

const checkToken = (token, callback) => {
	if (!token) {
		!!callback && callback(false);
	}
	else {
		db.find({token, deleted: null}, (error, records) => {
			const record = records[0];
			if (error || !record || !record.loggedIn) {
				!!callback && callback(false);
			}
			else {
				const expirationDate = moment(record.loggedIn).add(TOKEN_EXPIRATION_TIME, "seconds");
				!!callback && callback(moment().isBefore(expirationDate) ? expirationDate.format(DATE_TIME_FORMAT) : false);
			}
		});
	}
};

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

const createUser = (login, password, service, callback) => {
	const date = moment().format(DATE_TIME_FORMAT);
	db.insert({
		login: login,
		password: sha256(login + password + date),
		created: date,
		updated: date,
		deleted: null,
		loggedIn: null,
		token: null
	}, (error, record) => {
		if (error) {
			!!service && service.failure({
				status: 500,
				message: "Error inserting into database",
				errors: [error]
			});
			!!callback && callback(false);
		}
		else {
			const data = Object.assign({}, record);
			data.id = data._id;
			delete data._id;
			delete data.password;
			delete data.token;
			!!service && service.success({data});
			!!callback && callback(data);
		}
	});
};

const UserCreate = function (config) {
	return new ExpressRESTService(Object.assign({}, config, {
		args: {
			login: true,
			password: true
		},
		fn: (service, request, response) => {
			createUser(service.args.login, service.args.password, service);
		}
	}));
};

const loginUser = (login, password, record, service, callback) => {
	const errorObj = {
		status: 401,
		message: "Unauthenticated",
		errors: [],
		headers: {
			"WWW-Authenticate": 'Token realm="Access to the system"'
		}
	};
	const passwordHash = sha256(login + password + record.created);
	if (record.password !== passwordHash) {
		!!service && service.failure(errorObj);
		!!callback && callback(false);
	}
	else {
		const date = moment();
		const loggedIn = date.format(DATE_TIME_FORMAT);
		const expirationDate = date.clone().add(TOKEN_EXPIRATION_TIME, "seconds");
		const token = sha256(loggedIn + login + Math.random());
		updateRecord({login, deleted: null}, {token, loggedIn}, null, () => {
			const data = {token, expirationDate};
			!!service && service.success({data});
			!!callback && callback(data);
		});
	}
};

const UserLogin = function (config) {
	return new ExpressRESTService(Object.assign({}, config, {
		args: {
			login: true,
			password: true
		},
		fn: (service, request, response) => {
			const errorObj = {
				status: 401,
				message: "Unauthenticated",
				errors: [],
				headers: {
					"WWW-Authenticate": 'Token realm="Access to the system"'
				}
			};
			db.find({login: service.args.login, deleted: null}, (error, records) => {
				const record = records[0];
				if (error) {
					service.failure(errorObj);
				}
				else if (!record) {
					db.find({login: service.args.login, deleted: null}, (error, records)=> {
						if (error) {
							service.failure(errorObj);
						}
						else if (!records.length) {
							createUser(service.args.login, service.args.password, null, (record) => {
								loginUser(service.args.login, service.args.password, record, service);
							});
						}
						else {
							service.failure(errorObj);
						}
					})
				}
				else {
					loginUser(service.args.login, service.args.password, record, service);
				}
			});
		}
	}));
};

const UserLogout = function (config) {
	return new ExpressRESTService(Object.assign({}, config, {
		fn: (service, request, response) => {
			const token = String(service.headers["authorization"]).split("Token ")[1];
			updateRecord({token}, {token: null, loggedIn: null}, service);
		}
	}));
};

const UserGetSelf = function (config) {
	return new ExpressRESTService(Object.assign({}, config, {
		fn: (service, request, response) => {
			const token = String(service.headers["authorization"]).split("Token ")[1];
			db.find({token: token, deleted: null}, (error, records) => {
				const record = records[0];
				if (error) {
					service.failure({
						status: 404,
						message: "User not found",
						errors: [error]
					});
				}
				else {
					const data = Object.assign({}, record);
					data.id = data._id;
					delete data._id;
					delete data.password;
					delete data.token;
					service.success({data});
				}
			});
		}
	}));
};

const RenewToken = function (config) {
	return new ExpressRESTService(Object.assign({}, config, {
		fn: (service, request, response) => {
			const token = String(service.headers["authorization"]).split("Token ")[1];
			db.find({token, deleted: null}, (error, records) => {
				const record = records[0];
				if (error || !record) {
					service.failure({
						status: 404,
						message: "Token not found",
						errors: error ? [error] : []
					});
				}
				else {
					const date = moment();
					const loggedIn = date.format(DATE_TIME_FORMAT);
					const expirationDate = date.clone().add(TOKEN_EXPIRATION_TIME, "seconds");
					const token = sha256(loggedIn + record.login + Math.random());
					updateRecord({_id: record._id}, {token, loggedIn}, null, () => {
						const data = {token, expirationDate};
						service.success({data});
					});
				}
			});
		}
	}));
};

module.exports = {
	UserCreate,
	UserLogin,
	UserLogout,
	UserGetSelf,
	RenewToken,
	checkToken
};
