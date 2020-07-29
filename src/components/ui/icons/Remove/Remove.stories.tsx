// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React from 'react';

import { text } from '@storybook/addon-knobs';
import Remove from '.';
import RemoveIconDocs from './Remove.mdx';

export default {
  title: 'Icons/Remove',
  parameters: {
    docs: {
      page: RemoveIconDocs.parameters.docs.page().props.children.type
    }
  },
  component: Remove
};

export const _Remove = () => <Remove width={text('width', '2rem')} />;