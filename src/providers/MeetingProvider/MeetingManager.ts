// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AudioVideoFacade,
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
  DefaultActiveSpeakerPolicy,
  MeetingSessionStatus,
  MeetingSessionStatusCode,
  AudioVideoObserver
} from 'amazon-chime-sdk-js';

import {
  audioInputSelectionToDevice,
  videoInputSelectionToDevice
} from '../../utils/device-utils';
import { MeetingStatus } from '../../types';

enum DevicePermissionStatus {
  UNSET = 'UNSET',
  IN_PROGRESS = 'IN_PROGRESS',
  GRANTED = 'GRANTED',
  DENIED = 'DENIED'
}

interface MeetingJoinData {
  meetingInfo: any;
  attendeeInfo: any;
}

interface AttendeeResponse {
  name?: string;
}

type FullDeviceInfoType = {
  selectedAudioOutputDevice: string | null;
  selectedAudioInputDevice: string | null;
  selectedVideoInputDevice: string | null;
  audioInputDevices: MediaDeviceInfo[] | null;
  audioOutputDevices: MediaDeviceInfo[] | null;
  videoInputDevices: MediaDeviceInfo[] | null;
};

export class MeetingManager implements AudioVideoObserver{
  meetingSession: DefaultMeetingSession | null = null;

  meetingStatus: MeetingStatus = MeetingStatus.Loading;

  meetingStatusObservers: ((meetingStatus: MeetingStatus) => void)[] = [];

  audioVideo: AudioVideoFacade | null = null;

  audioVideoObservers: AudioVideoObserver = {};

  configuration: MeetingSessionConfiguration | null = null;

  meetingId: string | null = null;

  getAttendee?: (
    chimeAttendeeId: string,
    externalUserId?: string
  ) => Promise<AttendeeResponse>;

  selectedAudioOutputDevice: string | null = null;

  selectedAudioOutputDeviceObservers: ((
    deviceId: string | null
  ) => void)[] = [];

  selectedAudioInputDevice: string | null = null;

  selectedAudioInputDeviceObservers: ((deviceId: string | null) => void)[] = [];

  selectedVideoInputDevice: string | null = null;

  selectedVideoInputDeviceObservers: ((deviceId: string | null) => void)[] = [];

  audioInputDevices: MediaDeviceInfo[] | null = null;

  audioOutputDevices: MediaDeviceInfo[] | null = null;

  videoInputDevices: MediaDeviceInfo[] | null = null;

  devicePermissionStatus = DevicePermissionStatus.UNSET;

  devicePermissionsObservers: ((permission: string) => void)[] = [];

  activeSpeakerListener: ((activeSpeakers: string[]) => void) | null = null;

  activeSpeakerCallbacks: ((activeSpeakers: string[]) => void)[] = [];

  activeSpeakers: string[] = [];

  audioVideoCallbacks: ((audioVideo: AudioVideoFacade | null) => void)[] = [];

  devicesUpdatedCallbacks: ((
    fullDeviceInfo: FullDeviceInfoType
  ) => void)[] = [];

  logLevel: LogLevel = LogLevel.WARN;

  constructor(logLevel: LogLevel) {
    this.logLevel = logLevel;
  }

  initializeMeetingManager(): void {
    this.meetingSession = null;
    this.audioVideo = null;
    this.configuration = null;
    this.meetingId = null;
    this.selectedAudioOutputDevice = null;
    this.selectedAudioInputDevice = null;
    this.selectedVideoInputDevice = null;
    this.audioInputDevices = [];
    this.audioOutputDevices = [];
    this.videoInputDevices = [];
    this.activeSpeakers = [];
    this.activeSpeakerListener = null;
    this.meetingStatus = MeetingStatus.Loading;
    this.publishMeetingStatus();
    this.meetingStatusObservers = [];
    this.audioVideoObservers = {};
  }

  async join({ meetingInfo, attendeeInfo }: MeetingJoinData) {
    this.configuration = new MeetingSessionConfiguration(
      meetingInfo,
      attendeeInfo
    );
    this.meetingId = this.configuration.meetingId;
    await this.initializeMeetingSession(this.configuration);
  }

  async start(): Promise<void> {
    this.audioVideo?.start();
    await this.meetingSession?.screenShare.open();
    await this.meetingSession?.screenShareView.open();
  }

  async leave(): Promise<void> {
    if (this.audioVideo) {
      this.audioVideo.stopContentShare();
      this.audioVideo.stopLocalVideoTile();
      this.audioVideo.unbindAudioElement();
      await this.audioVideo.chooseVideoInputDevice(null);
      await this.audioVideo.chooseAudioInputDevice(null);
      await this.audioVideo.chooseAudioOutputDevice(null);
      
      if (this.activeSpeakerListener) {
        this.audioVideo.unsubscribeFromActiveSpeakerDetector(
          this.activeSpeakerListener
        );
      }

      this.audioVideo.stop();
      this.audioVideo.removeObserver(this.audioVideoObservers);
    }
    this.initializeMeetingManager();
    this.publishAudioVideo();
    this.publishActiveSpeaker();
  }

  async initializeMeetingSession(
    configuration: MeetingSessionConfiguration
  ): Promise<any> {
    const logger = new ConsoleLogger('SDK', this.logLevel);
    const deviceController = new DefaultDeviceController(logger);
    configuration.enableWebAudio = false;
    this.meetingSession = new DefaultMeetingSession(
      configuration,
      logger,
      deviceController
    );
    this.audioVideo = this.meetingSession.audioVideo;
    this.setupAudioVideoObservers();
    this.setupDeviceLabelTrigger();
    await this.listAndSelectDevices();
    this.publishAudioVideo();
    this.setupActiveSpeakerDetection();
    this.meetingStatus = MeetingStatus.Loading;
    this.publishMeetingStatus();
  }

  audioVideoDidStart = () => {
    console.log('[MeetingManager audioVideoDidStart] Meeting started successfully');
    this.meetingStatus = MeetingStatus.Succeeded;
    this.publishMeetingStatus();
  };

  audioVideoDidStop = (sessionStatus: MeetingSessionStatus) => {
    const sessionStatusCode = sessionStatus.statusCode();
    if (sessionStatusCode === MeetingSessionStatusCode.AudioCallEnded) {
      console.log('[MeetingManager audioVideoDidStop] Meeting ended for all');
      this.meetingStatus = MeetingStatus.Ended;
      this.publishMeetingStatus();
    }
    this.leave();
  };

  setupAudioVideoObservers() {
    if(!this.audioVideo) {
      return;
    }

    this.audioVideoObservers = {
      audioVideoDidStart: this.audioVideoDidStart,
      audioVideoDidStop: this.audioVideoDidStop
    };

    this.audioVideo.addObserver(this.audioVideoObservers);
  }

  async updateDeviceLists(): Promise<void> {
    this.audioInputDevices =
      (await this.audioVideo?.listAudioInputDevices()) || [];
    this.videoInputDevices =
      (await this.audioVideo?.listVideoInputDevices()) || [];
    this.audioOutputDevices =
      (await this.audioVideo?.listAudioOutputDevices()) || [];
  }

  setupDeviceLabelTrigger(): void {
    const callback = async (): Promise<MediaStream> => {
      this.devicePermissionStatus = DevicePermissionStatus.IN_PROGRESS;
      this.publishDevicePermissionStatus();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
      return stream;
    };
    this.audioVideo?.setDeviceLabelTrigger(callback);
    this.devicePermissionStatus = DevicePermissionStatus.GRANTED;
    this.publishDevicePermissionStatus();
  }

  setupActiveSpeakerDetection(): void {
    this.publishActiveSpeaker();

    this.activeSpeakerListener = (activeSpeakers: string[]) => {
      this.activeSpeakers = activeSpeakers;
      this.activeSpeakerCallbacks.forEach(cb => cb(activeSpeakers));
    };

    this.audioVideo?.subscribeToActiveSpeakerDetector(
      new DefaultActiveSpeakerPolicy(),
      this.activeSpeakerListener
    );
  }

  async listAndSelectDevices(): Promise<void> {
    await this.updateDeviceLists();
    if (
      !this.selectedAudioInputDevice &&
      this.audioInputDevices &&
      this.audioInputDevices.length
    ) {
      this.selectedAudioInputDevice = this.audioInputDevices[0].deviceId;
      await this.audioVideo?.chooseAudioInputDevice(
        this.audioInputDevices[0].deviceId
      );
      this.publishSelectedAudioInputDevice();
    }
    if (
      !this.selectedAudioOutputDevice &&
      this.audioOutputDevices &&
      this.audioOutputDevices.length
    ) {
      this.selectedAudioOutputDevice = this.audioOutputDevices[0].deviceId;
      await this.audioVideo?.chooseAudioOutputDevice(
        this.audioOutputDevices[0].deviceId
      );
      this.publishSelectedAudioOutputDevice();
    }
    if (
      !this.selectedVideoInputDevice &&
      this.videoInputDevices &&
      this.videoInputDevices.length
    ) {
      this.selectedVideoInputDevice = this.videoInputDevices[0].deviceId;
      await this.audioVideo?.chooseVideoInputDevice(
        this.videoInputDevices[0].deviceId
      );
      this.publishSelectedVideoInputDevice();
    }
  }

  selectAudioInputDevice = async (deviceId: string): Promise<void> => {
    try {
      const receivedDevice = audioInputSelectionToDevice(deviceId);
      if (receivedDevice === null) {
        await this.audioVideo?.chooseAudioInputDevice(null);
        this.selectedAudioInputDevice = null;
      } else {
        await this.audioVideo?.chooseAudioInputDevice(receivedDevice);
        this.selectedAudioInputDevice = deviceId;
      }
      this.publishSelectedAudioInputDevice();
    } catch (error) {
      console.error(`Error setting audio input - ${error}`);
    }
  };

  selectAudioOutputDevice = async (deviceId: string): Promise<void> => {
    try {
      await this.audioVideo?.chooseAudioOutputDevice(deviceId);
      this.selectedAudioOutputDevice = deviceId;
      this.publishSelectedAudioOutputDevice();
    } catch (error) {
      console.error(`Error setting audio output - ${error}`);
    }
  };

  selectVideoInputDevice = async (deviceId: string): Promise<void> => {
    try {
      const receivedDevice = videoInputSelectionToDevice(deviceId);
      if (receivedDevice === null) {
        await this.audioVideo?.chooseVideoInputDevice(null);
        this.selectedVideoInputDevice = null;
      } else {
        await this.audioVideo?.chooseVideoInputDevice(receivedDevice);
        this.selectedVideoInputDevice = deviceId;
      }
      this.publishSelectedVideoInputDevice();
    } catch (error) {
      console.error(`Error setting video input - ${error}`);
    }
  };

  /**
   * ====================================================================
   * Subscriptions
   * ====================================================================
   */

  subscribeToAudioVideo = (
    callback: (av: AudioVideoFacade | null) => void
  ): void => {
    this.audioVideoCallbacks.push(callback);
  };

  unsubscribeFromAudioVideo = (
    callbackToRemove: (av: AudioVideoFacade | null) => void
  ): void => {
    this.audioVideoCallbacks = this.audioVideoCallbacks.filter(
      callback => callback !== callbackToRemove
    );
  };

  publishAudioVideo = () => {
    this.audioVideoCallbacks.forEach(callback => {
      callback(this.audioVideo);
    });
  };

  subscribeToActiveSpeaker = (
    callback: (activeSpeakers: string[]) => void
  ): void => {
    this.activeSpeakerCallbacks.push(callback);
    callback(this.activeSpeakers);
  };

  unsubscribeFromActiveSpeaker = (
    callbackToRemove: (activeSpeakers: string[]) => void
  ): void => {
    this.activeSpeakerCallbacks = this.activeSpeakerCallbacks.filter(
      callback => callback !== callbackToRemove
    );
  };

  publishActiveSpeaker = () => {
    this.activeSpeakerCallbacks.forEach(callback => {
      callback(this.activeSpeakers);
    });
  };

  subscribeToDevicePermissionStatus = (
    callback: (permission: string) => void
  ): void => {
    this.devicePermissionsObservers.push(callback);
  };

  unsubscribeFromDevicePermissionStatus = (
    callbackToRemove: (permission: string) => void
  ): void => {
    this.devicePermissionsObservers = this.devicePermissionsObservers.filter(
      callback => callback !== callbackToRemove
    );
  };

  private publishDevicePermissionStatus = (): void => {
    for (let i = 0; i < this.devicePermissionsObservers.length; i += 1) {
      const callback = this.devicePermissionsObservers[i];
      callback(this.devicePermissionStatus);
    }
  };

  subscribeToSelectedVideoInputDevice = (
    callback: (deviceId: string | null) => void
  ): void => {
    this.selectedVideoInputDeviceObservers.push(callback);
  };

  unsubscribeFromSelectedVideoInputDevice = (
    callbackToRemove: (deviceId: string | null) => void
  ): void => {
    this.selectedVideoInputDeviceObservers = this.selectedVideoInputDeviceObservers.filter(
      callback => callback !== callbackToRemove
    );
  };

  private publishSelectedVideoInputDevice = (): void => {
    for (let i = 0; i < this.selectedVideoInputDeviceObservers.length; i += 1) {
      const callback = this.selectedVideoInputDeviceObservers[i];
      callback(this.selectedVideoInputDevice);
    }
  };

  subscribeToSelectedAudioInputDevice = (
    callback: (deviceId: string | null) => void
  ): void => {
    this.selectedAudioInputDeviceObservers.push(callback);
  };

  unsubscribeFromSelectedAudioInputDevice = (
    callbackToRemove: (deviceId: string | null) => void
  ): void => {
    this.selectedAudioInputDeviceObservers = this.selectedAudioInputDeviceObservers.filter(
      callback => callback !== callbackToRemove
    );
  };

  private publishSelectedAudioInputDevice = (): void => {
    for (let i = 0; i < this.selectedAudioInputDeviceObservers.length; i += 1) {
      const callback = this.selectedAudioInputDeviceObservers[i];
      callback(this.selectedAudioInputDevice);
    }
  };

  subscribeToSelectedAudioOutputDevice = (
    callback: (deviceId: string | null) => void
  ): void => {
    this.selectedAudioOutputDeviceObservers.push(callback);
  };

  unsubscribeFromSelectedAudioOutputDevice = (
    callbackToRemove: (deviceId: string | null) => void
  ): void => {
    this.selectedAudioOutputDeviceObservers = this.selectedAudioOutputDeviceObservers.filter(
      callback => callback !== callbackToRemove
    );
  };

  private publishSelectedAudioOutputDevice = (): void => {
    for (
      let i = 0;
      i < this.selectedAudioOutputDeviceObservers.length;
      i += 1
    ) {
      const callback = this.selectedAudioOutputDeviceObservers[i];
      callback(this.selectedAudioOutputDevice);
    }
  };

  subscribeToMeetingStatus = (callback: (meetingStatus: MeetingStatus) => void): void => {
    this.meetingStatusObservers.push(callback);
    callback(this.meetingStatus);
  }

  unsubscribeFromMeetingStatus = (callbackToRemove: (meetingStatus: MeetingStatus) => void): void => {
    this.meetingStatusObservers = this.meetingStatusObservers.filter(
      callback => callback !== callbackToRemove
    );
  }

  private publishMeetingStatus = () => {
    this.meetingStatusObservers.forEach(callback => {
      callback(this.meetingStatus);
    });
  }
}

export default MeetingManager;
