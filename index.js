const http = require('http');
const server = http.createServer();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const upload = multer({dest: './uploads/'});
const bodyParser = require('body-parser');
const fs = require('fs');

if(!fs.existsSync('./nodes')) {
	fs.mkdirSync('./nodes');
}
if(!fs.existsSync('./db')) {
	fs.mkdirSync('./db');
}
if(!fs.existsSync('./uploads')) {
	fs.mkdirSync('./uploads');
}
if(!fs.existsSync('./downloads')) {
	fs.mkdirSync('./downloads');
}

const NodeRESTService = require("./services/nodes.services.js");
const SecurityRESTService = require("./services/security.services.js");

//express
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

//services
const serviceConfig = {
    hasAccess: (service, request, callback) => {
        const token = (request.body || {})["token"] || (request.query || {})["token"] ||
            String(service.headers["authorization"]).split("Token ")[1];
        SecurityRESTService.checkToken(token, (expirationDate) => {
            !!callback && callback(expirationDate, true);
        });
    }
};

const userLogin = new SecurityRESTService.UserLogin(); //not secured
const userGetSelf = new SecurityRESTService.UserGetSelf(serviceConfig);
const userLogout = new SecurityRESTService.UserLogout(serviceConfig);
const userCreate = new SecurityRESTService.UserCreate(serviceConfig);
const renewToken = new SecurityRESTService.RenewToken(serviceConfig);

const systemInfo = new NodeRESTService.SystemInfo(serviceConfig);
const nodeCreate = new NodeRESTService.NodeCreate(serviceConfig);
const nodesList = new NodeRESTService.NodesList(serviceConfig);
const nodeGet = new NodeRESTService.NodeGet(serviceConfig);
const nodeUpdate = new NodeRESTService.NodeUpdate(serviceConfig);
const nodeDelete = new NodeRESTService.NodeDelete(serviceConfig);
const nodeTypesList = new NodeRESTService.NodeTypesList(serviceConfig);
const nodeStart = new NodeRESTService.NodeStart(serviceConfig);
const nodeStop = new NodeRESTService.NodeStop(serviceConfig);
const nodeUpload = new NodeRESTService.NodeUpload(serviceConfig);
const nodeDownload = new NodeRESTService.NodeDownload(serviceConfig);

app.get('/system', (req, res) => systemInfo.call(req, res));
app.get('/nodes', (req, res) => nodesList.call(req, res));
app.get('/node', (req, res) => nodeGet.call(req, res));
app.get('/node/types', (req, res) => nodeTypesList.call(req, res));
app.post('/node', (req, res) => nodeCreate.call(req, res));
app.put('/node', (req, res) => nodeUpdate.call(req, res));
app.delete('/node', (req, res) => nodeDelete.call(req, res));
app.put('/node/start', (req, res) => nodeStart.call(req, res));
app.put('/node/stop', (req, res) => nodeStop.call(req, res));
app.post('/fileupload', upload.single('upload'), (req, res) => nodeUpload.call(req, res));
app.get('/download', (req, res) => nodeDownload.call(req, res));

app.post('/login', (req, res) => userLogin.call(req, res));
app.get('/logout', (req, res) => userLogout.call(req, res));
app.post('/user', (req, res) => userCreate.call(req, res));
app.get('/me', (req, res) => userGetSelf.call(req, res));

app.get('/token/renew', (req, res) => renewToken.call(req, res));

NodeRESTService.init();

const errorHandler = (err) => {
    console.error(err);
};
server.on('request', app);
server.on('error', errorHandler);

server.listen(process.env.backendPort || 3031, () => {
    console.log('Listening on ' + server.address().port);
});
