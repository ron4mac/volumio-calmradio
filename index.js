'use strict'
var unirest=require('unirest');
var libQ=require('kew');
var ip = require('public-ip');
var fs=require('fs-extra');
var cron = require('node-schedule');
var moment=require('moment');

var tokenExpirationTime;

/**
 * CONSTRUCTOR
 */
module.exports = ControllerCalmRadio;

function ControllerCalmRadio(context) {
	var self=this;

    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;
}

ControllerCalmRadio.prototype.getConfigurationFiles = function () {
    var self = this;

    return ['config.json'];
};

ControllerCalmRadio.prototype.onVolumioStart = function () {
    var defer=libQ.defer();

    this.mpdPlugin=this.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
    var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);

    defer.resolve('');

    return defer.promise;
};

ControllerCalmRadio.prototype.onStart = function () {
    var defer=libQ.defer();

    this.loadI18n();
    this.startupLogin();
    this.startRefreshCron();

    defer.resolve('');

    return defer.promise;
};

ControllerCalmRadio.prototype.loadI18n = function () {
    var self=this;

    var language_code = this.commandRouter.sharedVars.get('language_code');
    fs.readJson(__dirname+'/i18n/strings_en.json', (err, defaulti18n) => {
        if (err) {} else {
            self.i18nStringsDefaults = defaulti18n;
            fs.readJson(__dirname+'/i18n/strings_'+language_code+".json", (err, langi18n) => {
                if (err) {
                    self.i18nStrings = self.i18nStringsDefaults;
                } else {
                    self.i18nStrings = langi18n;
                }
            });
        }
    });
};

ControllerCalmRadio.prototype.getI18n = function (key) {
    var self=this;

    if (key.indexOf('.') > 0) {
        var mainKey = key.split('.')[0];
        var secKey = key.split('.')[1];
        if (self.i18nStrings[mainKey][secKey] !== undefined) {
            return self.i18nStrings[mainKey][secKey];
        } else {
            return self.i18nStringsDefaults[mainKey][secKey];
        }

    } else {
        if (self.i18nStrings[key] !== undefined) {
            return self.i18nStrings[key];
        } else {
            return self.i18nStringsDefaults[key];
        }
    }
};

ControllerCalmRadio.prototype.startupLogin = function () {
    var self=this;

    self.shallLogin()
        .then(()=>self.loginToCalmRadio(this.config.get('username'), this.config.get('password'), false))
        .then(()=>self.registerIPAddress())
        .then(()=>self.addToBrowseSources())
};

ControllerCalmRadio.prototype.shallLogin = function () {
    var self=this;
    var defer=libQ.defer()

    if(this.config.get("loggedin",false) 
        && this.config.get("username")
        && this.config.get("username")!=""
        && this.config.get("password")
        && this.config.get("password")!="")
    {
        defer.resolve()
    } else 
    {
        defer.reject()
    }
    
    return defer.promise
};

ControllerCalmRadio.prototype.loginToCalmRadio=function(username, password) {
    var defer=libQ.defer()
    var self=this;

    self.logger.info('Loggin in to CalmRadio');

    unirest.post('https://api.calmradio.com/get_token')
        .send('user='+username)
        .send('pass='+password)
        .then((response)=>{
            if(response && 
                response.cookies && 
                'PHPSESSID' in response.cookies && 
                response.status === 200 &&
                response.body &&
                'user' in response.body &&
                'id' in response.body['user'])
            {
                self.sessionId=response.cookies['PHPSESSID']
                
                self.userId=response.body['user']["id"]
                self.userEmail=response.body['user']["email"]
                
                self.config.set("loggedin",true)
                defer.resolve()
            } else {
                defer.reject()
            }   
        })

    return defer.promise
}

ControllerCalmRadio.prototype.registerIPAddress=function() {
    var self=this
    var defer=libQ.defer()
    
    ip.v4().then((address)=>{
        var cookieJar=unirest.jar()
        cookieJar.add('PHPSESSID='+self.sessionId,'https://users.calmradio/api/user/updateip')

        var request=unirest.post('https://users.calmradio/api/user/updateip')
            .jar(cookieJar)
            .send('id='+self.userId)
            .send('ip='+address)
            .then((response)=>{
                if(response && 
                    response.status === 200 &&
                    'user' in response.body)
                {
                    defer.resolve()
                } else {
                    defer.reject()
                }   
            })
    }).catch((error)=>{
        defer.reject()
    })

    return defer.promise
}

ControllerCalmRadio.prototype.onStop = function () {
    var self = this;
    var defer=libQ.defer();

    self.commandRouter.volumioRemoveToBrowseSources('calmradio');
    self.stopRefreshCron();

    defer.resolve('');

    return defer.promise;
};

ControllerCalmRadio.prototype.addToBrowseSources = function () {
    var self = this;

    self.logger.info('Adding Calm Radio to Browse Sources');
    var data = {name: 'calmradio', uri: 'calmradio://',plugin_type:'music_service',plugin_name:'calmradio',albumart:'/albumart?sectionimage=music_service/calmradio/icons/calmradio-icon.png'};
    return self.commandRouter.volumioAddToBrowseSources(data);
}

ControllerCalmRadio.prototype.handleBrowseUri = function (curUri) {
    switch(curUri)
    {
        case 'calmradio://':
            return this.handleRootBrowseUri()

        default:
            return this.handleGroupBrowseUri(curUri)
    }
};

ControllerCalmRadio.prototype.handleRootBrowseUri=function() {
    var defer=libQ.defer()
    var self=this

    var cookieJar = unirest.jar()
    cookieJar.add('PHPSESSID=' + this.sessionId, 'https://users.calmradio/api/channelgroups/user')

    var request = unirest.post('https://users.calmradio/api/channelgroups/user')
        .jar(cookieJar)
        .send('id=' + this.userId)
        .then((response) => {
            if (response &&
                response.status === 200 &&
                'channel_groups' in response.body) {
                var groupItems = []
                response.body['channel_groups'].map(group => {
                    groupItems.push({
                        "type": "item-no-menu",
                        "title": group['group_name'],
                        "albumart": group['group_cover'],
                        "uri": `calmradio://${group['id']}`
                    })
                })

                var browseResponse={
                    "navigation": {
                        "lists": [
                            {
                                "type": "title",
                                "title": "TRANSLATE.CALMRADIO.GROUPS",
                                "availableListViews": [
                                    "grid", "list"
                                ],
                                "items": groupItems
                            }]
                    }
                }
                self.commandRouter.translateKeys(browseResponse, self.i18nStrings, self.i18nStringsDefaults);

                defer.resolve(browseResponse)
            } else {
                defer.reject()
            }
        })

    return defer.promise
}

ControllerCalmRadio.prototype.handleGroupBrowseUri=function(curUri) {
    var defer=libQ.defer()
    var self=this

    var groupId=curUri.split('/')[2]

    var cookieJar = unirest.jar()
    cookieJar.add('PHPSESSID=' + this.sessionId, 'https://users.calmradio/api/channels/group')

    var request = unirest.post('https://users.calmradio/api/channels/group')
        .jar(cookieJar)
        .send('id=' + groupId)
        .then((response) => {
            if (response &&
                response.status === 200 &&
                'channels' in response.body) {
                var channelItems = []
                response.body['channels'].map(channel => {
                    channelItems.push({
                        "type": "webradio",
                        "title": channel['stream_name'],
                        "albumart": channel['channel_cover'],
                        "uri": `calmradio://${groupId}/${channel['id']}`,
                        "service":"calmradio"

                    })
                })

                var browseResponse={
                    "navigation": {
                        "lists": [
                            {
                                "type": "title",
                                "title": "TRANSLATE.CALMRADIO.CHANNELS",
                                "availableListViews": [
                                    "grid", "list"
                                ],
                                "items": channelItems
                            }]
                    }
                }
                self.commandRouter.translateKeys(browseResponse, self.i18nStrings, self.i18nStringsDefaults);

                defer.resolve(browseResponse)
            } else {
                defer.reject()
            }
        })

    return defer.promise
}

ControllerCalmRadio.prototype.explodeUri = function(curUri) {
    var defer=libQ.defer()
    var self=this

    var groupId=curUri.split('/')[2]
    var channelId= curUri.split('/')[3]

    var cookieJar = unirest.jar()
    cookieJar.add('PHPSESSID=' + this.sessionId, 'https://users.calmradio/api/channels/group')

    var request = unirest.post('https://users.calmradio/api/channels/group')
        .jar(cookieJar)
        .send('id=' + groupId)
        .then((response) => {
            if (response &&
                response.status === 200 &&
                'channels' in response.body) {


                var explodeResp =  {
                            "uri": curUri,
                            "service": "calmradio",
                            "name": "",
                            "title": "",
                            "album": "",
                            "type": "track",
                            "albumart": "/albumart?sectionimage=music_service/calmradio/icons/calmradio-icon.png"
                        }

                response.body['channels'].map(channel => {
                    if(channel['id']==channelId)
                    {
                        explodeResp['name']=channel['stream_name']
                        explodeResp['title']=channel['stream_name']
                        explodeResp['albumart']=channel['channel_cover']
                    }
                })

                defer.resolve([explodeResp])
            } else {
                defer.reject()
            }
        })

    return defer.promise
};

ControllerCalmRadio.prototype.getStreamUrl = function (curUri) {
    var defer=libQ.defer()
    var self=this

    var groupId=curUri.split('/')[2]
    var channelId= curUri.split('/')[3]

    var cookieJar = unirest.jar()
    cookieJar.add('PHPSESSID=' + this.sessionId, 'https://users.calmradio/api/channels/group')

    var request = unirest.post('https://users.calmradio/api/channels/group')
        .jar(cookieJar)
        .send('id=' + groupId)
        .then((response) => {
            if (response &&
                response.status === 200 &&
                'channels' in response.body) {


                var explodeResp = {
                    "uri": ""
                }
                response.body['channels'].map(channel => {
                    if(channel['id']==channelId)
                    {
                        if(channel["mp3128_stream_dir"] && channel['mp3128_stream_dir']!="")
                        {
                            explodeResp['uri']=channel['stream_path']+channel["mp3128_stream_dir"]
                        }
                        else if(channel['aacp_stream_dir'] && channel['aacp_stream_dir']!="")
                        {
                            explodeResp['uri']=channel['stream_path']+channel["aacp_stream_dir"]
                        } 
                        else {
                            explodeResp['uri']=channel['stream_path']+channel["stream_dir"]
                        }
                        
                    }
                })

                defer.resolve(explodeResp)
            } else {
                defer.reject()
            }
        })

    return defer.promise
}

ControllerCalmRadio.prototype.clearAddPlayTrack = function(track) {
    var self = this;
    var defer=libQ.defer();

    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerCalmRadio::clearAddPlayTrack');
    

    self.getStreamUrl(track.uri)
        .then(function(track) {
            return self.mpdPlugin.sendMpdCommand('stop',[])
                .then(function() {
                    return self.mpdPlugin.sendMpdCommand('clear',[]);
                })
                .then(function(stream) {
                    return self.mpdPlugin.sendMpdCommand('load "'+track.uri+'"',[]);
                })
                .fail(function (e) {
                    return self.mpdPlugin.sendMpdCommand('add "'+track.uri+'"',[]);
                })
                .then(function() {
                    self.commandRouter.stateMachine.setConsumeUpdateService('mpd');
                    return self.mpdPlugin.sendMpdCommand('play',[]);
                })
                .fail(function (e) {
                    self.logger.error('Could not Clear and Play CALMRADIO Track: ' + e);
                    defer.reject(new Error());
                })
            ;
        })
        .fail(function(e)
        {   self.logger.error('Could not get HOTERADIO Stream URL: ' + e);
            defer.reject(new Error());
        });

    return defer;
};

ControllerCalmRadio.prototype.stop = function() {
    var self = this;
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerCalmRadio::stop');
    
    return self.mpdPlugin.sendMpdCommand('stop', []);
};

ControllerCalmRadio.prototype.getUIConfig = function () {
    var self = this;

    var defer=libQ.defer();
    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+this.commandRouter.sharedVars.get('language_code')+'.json',
        __dirname+'/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function(uiconf)
        {
            if (self.isLoggedIn()) {
                uiconf.sections[0].content[0].hidden=true;
                uiconf.sections[0].content[1].hidden=true;
                uiconf.sections[0].content[2].hidden=true;
                uiconf.sections[0].content[3].hidden=true;
                //uiconf.sections[0].content[4].hidden=false;
                
                uiconf.sections[0].description=self.getI18n("CALMRADIO.LOGGED_IN_EMAIL")+self.userEmail;
                uiconf.sections[0].saveButton.label=self.getI18n("COMMON.LOGOUT")
                uiconf.sections[0].onSave.method="clearAccountCredentials"
            } else {
                uiconf.sections[0].content[0].hidden=false;
                uiconf.sections[0].content[1].hidden=false;
                uiconf.sections[0].content[2].hidden=false;
                uiconf.sections[0].content[3].hidden=true;
                //uiconf.sections[0].content[4].hidden=true;

                switch(self.commandRouter.sharedVars.get('language_code'))
                {
                    case 'de':
                        uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/volumio";
                    break

                    case 'it':
                        uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/it/volumio";
                    break

                    case 'fr':
                        uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/fr/volumio";
                    break

                    case 'es':
                        uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/es/volumio";
                    break

                    default:
                        uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/en/volumio";
                    break


                }
                

                uiconf.sections[0].description=self.getI18n("CALMRADIO.ACCOUNT_LOGIN_DESC")
                uiconf.sections[0].saveButton.label=self.getI18n("COMMON.LOGIN")
                uiconf.sections[0].onSave.method="saveAccountCredentials"
            }

            defer.resolve(uiconf);
        })
        .fail(function(e)
        {
            self.logger.error('Could not fetch CALMRADIO UI Configuration: ' + e);
            defer.reject(new Error());
        });

    return defer.promise;
};

ControllerCalmRadio.prototype.saveAccountCredentials = function (settings) {
    var self=this;
    var defer=libQ.defer();

    self.loginToCalmRadio(settings['calmradio_username'], settings['calmradio_password'], 'user')
        .then(() => self.registerIPAddress())
        .then(() => self.addToBrowseSources())
        .then(()=>{
            this.config.set('username', settings['calmradio_username'])
            this.config.set('password',settings['calmradio_password'])

            var config = self.getUIConfig();
            config.then(function(conf) {
                self.commandRouter.broadcastMessage('pushUiConfig', conf);
            });

            self.commandRouter.pushToastMessage('success', self.getI18n('COMMON.LOGGED_IN'));
            defer.resolve({})
        })
        .fail(()=>{
            self.commandRouter.pushToastMessage('error', self.getI18n('COMMON.ERROR_LOGGING_IN'));
            defer.reject()
        })
    
    return defer.promise
}

ControllerCalmRadio.prototype.clearAccountCredentials = function (settings) {
    var self=this;
    var defer=libQ.defer();

    self.logoutFromCalmRadio(settings['calmradio_username'], settings['calmradio_password'])
        //.then(() => self.registerIPAddress())
        .then(() => self.commandRouter.volumioRemoveToBrowseSources('calmradio'))
        .then(()=>{
            var config = self.getUIConfig();
            config.then(function(conf) {
                self.commandRouter.broadcastMessage('pushUiConfig', conf);
            })

            self.commandRouter.pushToastMessage('success', self.getI18n('COMMON.LOGGED_OUT'));
            defer.resolve({})
        })
        .fail(()=>{
            self.commandRouter.pushToastMessage('error', self.getI18n('COMMON.ERROR_LOGGING_OUT'));
            defer.reject()
        })
    
    return defer.promise
}

ControllerCalmRadio.prototype.logoutFromCalmRadio=function(username, password) {
    var defer=libQ.defer()
    var self=this

    unirest.post('https://users.calmradio/api/index/logout')
        .send('username='+username)
        .send('password='+password)
        .then((response)=>{
            if(response && 
                response.cookies && 
                'PHPSESSID' in response.cookies && 
                response.status === 200 &&
                response.body &&
                response.body.code == 200)
            {   
                this.config.set('username', "")
                this.config.set('password', "")
                this.config.set("loggedin", false)

                defer.resolve()
            } else {
                defer.reject()
            }   
        })

    return defer.promise
}

ControllerCalmRadio.prototype.isLoggedIn = function () {
    return this.config.get("loggedin", false)
}

ControllerCalmRadio.prototype.startRefreshCron=function() {
    var self=this;

    this.stopRefreshCron();

    // Refreshing login every 12 hours
    var m=moment();
    var cronString=m.second()+' '+m.minute()+' '+m.hour()+','+(m.hour()+12)%24+' * * *';
    this.accessTokenRefreshCron=cron.scheduleJob(cronString, () => {
        self.startupLogin();
    });

    this.logger.info('AccessToken refresher cron started for Calm Radio');
}

ControllerCalmRadio.prototype.stopRefreshCron=function() {
    if(this.accessTokenRefreshCron)
    {
        this.accessTokenRefreshCron.cancel()
        this.accessTokenRefreshCron=undefined
    }

    this.logger.info('Stopping AccessToken refresher cron for Calm Radio');
}