'use strict'
const unirest = require('unirest')
const libQ = require('kew')
const fs = require('fs-extra')
const NodeCache = require('node-cache')

const CRURLS = {
		categories: 'https://api.calmradio.com/categories.json',
		channels: 'https://api.calmradio.com/channels.json',
		arts: 'https://arts.calmradio.com',
		token: 'https://api.calmradio.com/get_token'
	}

/**
 * CONSTRUCTOR
 */
module.exports = ControllerCalmRadio

function ControllerCalmRadio (context) {
	let self = this

	this.context = context
	this.commandRouter = this.context.coreCommand
	this.logger = this.context.logger
	this.configManager = this.context.configManager
	self.cache = new NodeCache({stdTTL: 86400, checkperiod: 3600})
}

ControllerCalmRadio.prototype.getConfigurationFiles = function () {
	let self = this

	return ['config.json']
}

ControllerCalmRadio.prototype.onVolumioStart = function () {
	let defer = libQ.defer()

	this.mpdPlugin = this.commandRouter.pluginManager.getPlugin('music_service', 'mpd')
	let configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json')
	this.config = new (require('v-conf'))()
	this.config.loadFile(configFile)

	defer.resolve('')

	return defer.promise
}

ControllerCalmRadio.prototype.onStart = function () {
	let defer = libQ.defer()

	this.loadI18n()
	this.startupLogin()

	defer.resolve('')

	return defer.promise
}

ControllerCalmRadio.prototype.loadI18n = function () {
	let self = this

	let language_code = this.commandRouter.sharedVars.get('language_code')
	fs.readJson(__dirname+'/i18n/strings_en.json', (err, defaulti18n) => {
		if (err) {} else {
			self.i18nStringsDefaults = defaulti18n
			fs.readJson(__dirname+'/i18n/strings_'+language_code+".json", (err, langi18n) => {
				if (err) {
					self.i18nStrings = self.i18nStringsDefaults
				} else {
					self.i18nStrings = langi18n
				}
			})
		}
	})
}

ControllerCalmRadio.prototype.getI18n = function (key) {
	let self = this

	if (key.indexOf('.') > 0) {
		let mainKey = key.split('.')[0]
		let secKey = key.split('.')[1]
		if (self.i18nStrings[mainKey][secKey] !== undefined) {
			return self.i18nStrings[mainKey][secKey]
		} else {
			return self.i18nStringsDefaults[mainKey][secKey]
		}
	} else {
		if (self.i18nStrings[key] !== undefined) {
			return self.i18nStrings[key]
		} else {
			return self.i18nStringsDefaults[key]
		}
	}
}

ControllerCalmRadio.prototype.startupLogin = function () {
	let self = this

	self.shallLogin()
		.then(() => self.loginToCalmRadio(this.config.get('username'), this.config.get('password'), false))
		.then(() => self.addToBrowseSources())
}

ControllerCalmRadio.prototype.shallLogin = function () {
	let self = this
	let defer=libQ.defer()

	if (this.config.get("loggedin",false) 
		&& this.config.get("username")
		&& this.config.get("username")!=""
		&& this.config.get("password")
		&& this.config.get("password")!="")
	{
		defer.resolve()
	} else {
		defer.reject()
	}
	
	return defer.promise
}

ControllerCalmRadio.prototype.loginToCalmRadio = function(username, password) {
	let defer = libQ.defer()
	let self = this

	self.logger.info('Loggin in to CalmRadio')

	unirest.get(CRURLS.token+'?user='+username+'&pass='+password)
		.then((response) => {
			if(response && 
				response.status === 200 &&
				response.body &&
				'membership' in response.body &&
				response.body['membership'] == 'active')
			{
				self.userToken=response.body['token']
				self.config.set('username', username)
				self.config.set('password', password)
				self.config.set('token', response.body['token'])
				self.config.set('loggedin',true)
				defer.resolve()
			} else {
				defer.reject()
			}	
		})

	return defer.promise
}

ControllerCalmRadio.prototype.onStop = function () {
	let self = this
	let defer = libQ.defer()

	self.commandRouter.volumioRemoveToBrowseSources('calmradio')

	defer.resolve('')

	return defer.promise
}

ControllerCalmRadio.prototype.addToBrowseSources = function () {
	let self = this

	self.logger.info('Adding Calm Radio to Browse Sources')
	let data = {
		name: 'Calm Radio',
		uri: 'calmradio://',
		plugin_type: 'music_service',
		plugin_name: 'calmradio',
		albumart: '/albumart?sourceicon=music_service/calmradio/icons/calmradio-icon.png'
	}
	return self.commandRouter.volumioAddToBrowseSources(data)
}

ControllerCalmRadio.prototype.getCalmRadioData = function (which) {
	let self = this
	let defer = libQ.defer()

	if (self.cache.has(which)) {
		defer.resolve(self.cache.get(which))
	} else {
		self.logger.info('Getting Calm Radio '+which+' data')
		let request = unirest.get(CRURLS[which])
			.then(response => {
				if (response && response.status === 200) {
					self.cache.set(which, response.body)
					defer.resolve(response.body)
				} else {
					defer.reject()
				}
			})
	}

	return defer.promise
}

ControllerCalmRadio.prototype.getGroupName = function (groupId) {
	let self = this
	let gnam = `- - ${groupId} - -`

	if (self.cache.has('categories')) {
		let cats = self.cache.get('categories')
		cats.map(group => {
			if (group['categories']) {
				group['categories'].map(sgrp => {
					if (sgrp['id'] == groupId) {
						gnam = sgrp['name']
					}
				})
			}
		})
	}

	return gnam
}

ControllerCalmRadio.prototype.handleBrowseUri = function (curUri) {
	switch (curUri) {
		case 'calmradio://':
			return this.handleRootBrowseUri()

		default:
			return this.handleGroupBrowseUri(curUri)
	}
}

ControllerCalmRadio.prototype.doListCategories = function (bg) {
	let self = this
	let cats = self.cache.get('categories')
	let groupItems = []
	let catt = ''

	self.logger.info('Listing Calm Radio Categories '+bg)
	cats.map(group => {
		if (bg) {
			if (bg == group['id'] && group['categories']) {
				catt = group['name'].replace('CALMRADIO - ','')
				group['categories'].map(sgrp => {
					groupItems.push({
						"type": "item-no-menu",
						"title": sgrp['name'].replace('CALMRADIO - ',''),
						"albumart": CRURLS.arts + sgrp['image'],
						"uri": `calmradio://${bg}/${sgrp['id']}`
					})
				})
			}
		} else {
			groupItems.push({
				"type": "item-no-menu",
				"title": group['name'],
				"albumart": '/albumart?sectionimage=music_service/calmradio/'+group['name']+'.png',
				"uri": `calmradio://${group['id']}`
			})
		}
//		if (group['categories']) {
//			group['categories'].map(sgrp => {
//				groupItems.push({
//					"type": "item-no-menu",
//					"title": '&nbsp;&nbsp;' + sgrp['name'],
//					"albumart": 'http://arts.calmradio.com' + sgrp['image'],
//					"uri": `calmradio://${sgrp['id']}`
//				})
//			})
//		}
	})

	let browseResponse = {
		"navigation": {
			"lists": [
				{
					"type": "title",
					"title": bg ? (catt + ' ' + self.getI18n("CALMRADIO.GROUPS")) : self.getI18n("CALMRADIO.CATEGORIES"),
				//	"availableListViews": ["grid", "list"],
					"availableListViews": ["grid"],
					"items": groupItems
				}]
		}
	}
	self.commandRouter.translateKeys(browseResponse, self.i18nStrings, self.i18nStringsDefaults)

	return browseResponse
}

ControllerCalmRadio.prototype.handleRootBrowseUri = function () {
	let defer = libQ.defer()
	let self = this

	self.logger.info('Calm Radio root browse')
	self.getCalmRadioData('categories')
		.then(() => {
			defer.resolve(this.doListCategories())
		})

	return defer.promise
}

ControllerCalmRadio.prototype.doListChannels = function (groupId) {
	let self = this
	self.logger.info('Calm Radio list channels for group '+groupId)
	let chans = self.cache.get("channels")

	let channelItems = []
	let catt = this.getGroupName(groupId) + ' '
	chans.map(cat => {
		if (cat['category'] == groupId) {
			cat['channels'].map(channel => {
				channelItems.push({
					"type": "webradio",
					"title": channel['title'].replace('CALMRADIO - ',''),
					"albumart": CRURLS.arts + channel['image'],
					"uri": `calmradio://${groupId}/${channel['id']}`,
					"service":"calmradio"
				})
			})
		}
	})

	let browseResponse = {
		"navigation": {
			"lists": [
				{
					"type": "title",
					"title": catt + self.getI18n("CALMRADIO.CHANNELS"),
					"availableListViews": ["grid", "list"],
					"items": channelItems
				}]
		}
	}
	self.commandRouter.translateKeys(browseResponse, self.i18nStrings, self.i18nStringsDefaults)

	return browseResponse
}

ControllerCalmRadio.prototype.handleGroupBrowseUri = function (curUri) {
	let defer = libQ.defer()
	let self = this

	self.logger.info('Calm Radio group browse '+curUri)
	let groupId = curUri.split('/')[2]
	let subgrId = curUri.split('/')[3]

	if (subgrId > 0) {
		if (self.cache.has("channels")) {
			defer.resolve(this.doListChannels(subgrId))
			return defer.promise
		}
	} else {
		defer.resolve(this.doListCategories(groupId))
		return defer.promise
	}

//	if (subgrId == undefined) defer.resolve()

	self.logger.info('Getting Calm Radio Channels for Group '+subgrId)
	self.getCalmRadioData('channels')
		.then(() => {
			defer.resolve(this.doListChannels(subgrId))
		})

	return defer.promise
}

ControllerCalmRadio.prototype.explodeUri = function (uri) {
	let self = this
	let defer=libQ.defer()

	let groupId = uri.split('/')[2]
	let channelId = uri.split('/')[3]
	self.logger.info('Calm Radio explodeUri for Cat ' + groupId + ' Chan ' + channelId)

	let albart = null
	let chans = self.cache.get("channels")
	chans.map(cat => {
		if (cat['category'] == groupId) {
			cat['channels'].map(channel => {
				if (channel['id'] == channelId) {
					albart = CRURLS.arts + channel['image']
				}
			})
		}
	})

	defer.resolve({
		uri: uri,
		service: 'calmradio',
		name: "DO THE LOOKUP",
		albumart: albart,
		type: 'track'
	})

	return defer.promise
}

ControllerCalmRadio.prototype.getCalmChannelUrl = function (curUri) {
	let self = this

	let groupId = curUri.split('/')[2]
	let channelId = curUri.split('/')[3]

	self.logger.info('Calm Radio get URL for Cat ' + groupId + ' Chan ' + channelId)

	let chans = self.cache.get("channels")

	let explodeResp = {"uri": ""}

	chans.map(cat => {
		if (cat['category'] == groupId) {
			cat['channels'].map(channel => {
				if (channel['id'] == channelId) {
					let cred = self.config.get('username') + ':' + self.config.get('token')
					explodeResp['uri'] = channel['streams']['192'].replace('://','://'+cred+'@')
				//	explodeResp['albumart'] = 'http://arts.calmradio.com' + channel['image']
				//	self.config.set('chanart', 'http://arts.calmradio.com' + channel['image'])
				}
			})
		}
	})
console.log(explodeResp);
	return explodeResp
}

ControllerCalmRadio.prototype.getStreamUrl = function (curUri) {
	let defer = libQ.defer()
	let self = this

	let groupId = curUri.split('/')[2]
	let channelId = curUri.split('/')[3]

	self.logger.info('Calm Radio getStreamUrl for Cat ' + groupId + ' Chan ' + channelId)
	self.getCalmRadioData('channels')
		.then(() => {
			defer.resolve(this.getCalmChannelUrl(curUri))
		})

	return defer.promise
}

ControllerCalmRadio.prototype.clearAddPlayTrack = function (track) {
	let self = this
	let defer = libQ.defer()
console.log(track)
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerCalmRadio::clearAddPlayTrack')


	self.getStreamUrl(track.uri)
		.then((track) => {
			return self.mpdPlugin.sendMpdCommand('stop',[])
				.then(function() {
					return self.mpdPlugin.sendMpdCommand('clear',[])
				})
				.then(function(stream) {
					return self.mpdPlugin.sendMpdCommand('load "'+track.uri+'"',[])
				})
				.fail(function (e) {
					return self.mpdPlugin.sendMpdCommand('add "'+track.uri+'"',[])
				})
				.then(function() {
					self.commandRouter.stateMachine.setConsumeUpdateService('mpd')
					return self.mpdPlugin.sendMpdCommand('play',[])
				})
				.fail(function (e) {
					self.logger.error('Could not Clear and Play CALMRADIO Track: ' + e)
					defer.reject(new Error())
				})
		})
		.fail((e) => {
			self.logger.error('Could not get HOTERADIO Stream URL: ' + e)
			defer.reject(new Error())
		})

	return defer
}

ControllerCalmRadio.prototype.stop = function () {
	let self = this
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerCalmRadio::stop')

	return self.mpdPlugin.sendMpdCommand('stop', [])
}

ControllerCalmRadio.prototype.getUIConfig = function () {
	let self = this

	let defer = libQ.defer()
	self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+this.commandRouter.sharedVars.get('language_code')+'.json',
		__dirname+'/i18n/strings_en.json',
		__dirname + '/UIConfig.json')
		.then((uiconf) => {
			if (self.isLoggedIn()) {
				uiconf.sections[0].content[0].hidden=true
				uiconf.sections[0].content[1].hidden=true
				uiconf.sections[0].content[2].hidden=true
				uiconf.sections[0].content[3].hidden=true
				//uiconf.sections[0].content[4].hidden=false

				uiconf.sections[0].description=self.getI18n("CALMRADIO.LOGGED_IN_EMAIL")+self.config.get('username')
				uiconf.sections[0].saveButton.label=self.getI18n("COMMON.LOGOUT")
				uiconf.sections[0].onSave.method="clearAccountCredentials"
			} else {
				uiconf.sections[0].content[0].hidden=false
				uiconf.sections[0].content[1].hidden=false
				uiconf.sections[0].content[2].hidden=false
				uiconf.sections[0].content[3].hidden=true
				//uiconf.sections[0].content[4].hidden=true

				switch (self.commandRouter.sharedVars.get('language_code')) {
					case 'de':
						uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/volumio"
					break

					case 'it':
						uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/it/volumio"
					break

					case 'fr':
						uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/fr/volumio"
					break

					case 'es':
						uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/es/volumio"
					break

					default:
						uiconf.sections[0].content[0].onClick.performerUrl="https://calmradio/en/volumio"
					break
				}

				uiconf.sections[0].description=self.getI18n("CALMRADIO.ACCOUNT_LOGIN_DESC")
				uiconf.sections[0].saveButton.label=self.getI18n("COMMON.LOGIN")
				uiconf.sections[0].onSave.method="saveAccountCredentials"
			}

			defer.resolve(uiconf)
		})
		.fail((e) => {
			self.logger.error('Could not fetch CALMRADIO UI Configuration: ' + e)
			defer.reject(new Error())
		})

	return defer.promise
}

ControllerCalmRadio.prototype.saveAccountCredentials = function (settings) {
	let self = this
	let defer = libQ.defer()

	self.loginToCalmRadio(settings['calmradio_username'], settings['calmradio_password'], 'user')
		.then(() => self.addToBrowseSources())
		.then(() => {
			this.config.set('username', settings['calmradio_username'])
			this.config.set('password', settings['calmradio_password'])

			let config = self.getUIConfig()
			config.then(function(conf) {
				self.commandRouter.broadcastMessage('pushUiConfig', conf)
			})

			self.commandRouter.pushToastMessage('success', self.getI18n('COMMON.LOGGED_IN'))
			defer.resolve({})
		})
		.fail(() => {
			self.commandRouter.pushToastMessage('error', self.getI18n('COMMON.ERROR_LOGGING_IN'))
			defer.reject()
		})

	return defer.promise
}

ControllerCalmRadio.prototype.clearAccountCredentials = function (settings) {
	let self = this
	let defer = libQ.defer()

	self.logoutFromCalmRadio(settings['calmradio_username'], settings['calmradio_password'])
		.then(() => self.commandRouter.volumioRemoveToBrowseSources('calmradio'))
		.then(() => {
			let config = self.getUIConfig()
			config.then(function(conf) {
				self.commandRouter.broadcastMessage('pushUiConfig', conf)
			})

			self.commandRouter.pushToastMessage('success', self.getI18n('COMMON.LOGGED_OUT'))
			defer.resolve({})
		})
		.fail(() => {
			self.commandRouter.pushToastMessage('error', self.getI18n('COMMON.ERROR_LOGGING_OUT'))
			defer.reject()
		})

	return defer.promise
}

ControllerCalmRadio.prototype.logoutFromCalmRadio = function (username, password) {
	let defer = libQ.defer()
	let self = this

	unirest.get('http://api.calmradio.com/check?user='+username+'&pass='+password)
		.then((response) => {
			if(response &&
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
